#!/usr/bin/env node
/**
 * Peuple un projet avec un monde de démonstration cohérent.
 *
 * ## Pourquoi écrire en base plutôt que rejouer l'ingestion
 *
 * L'ingestion dérive la clé visiteur de l'IP et de l'User-Agent **du jour
 * courant** : rejouer six mois de trafic par l'API rangerait tout le passé sous
 * les clés d'aujourd'hui, et la rotation quotidienne — qui est précisément ce
 * qu'on veut voir à l'écran — disparaîtrait. On écrit donc les lignes
 * directement, en reproduisant les deux invariants qui comptent :
 *
 * - `sessions.visitor_key` vaut la clé **durable** quand le visiteur a
 *   consenti, et une clé qui **tourne chaque jour** sinon ;
 * - `events.visitor_key` n'est posé que sur le mode durable — c'est ce qui rend
 *   un paiement corrélable à une visite, et rien d'autre.
 *
 * La clé durable est calculée avec le vrai HMAC (`VISITOR_KEY_SECRET`), sans
 * quoi `firstVisits` — qui la recalcule côté API — ne retrouverait rien.
 *
 * ## Ce que le jeu contient exprès
 *
 * Il n'est pas uniforme : une campagne chère qui ne convertit pas, une
 * newsletter minuscule qui convertit dix fois mieux, un pic Product Hunt sur un
 * jour, des robots, des refus de consentement, des clients sans metadata. Un
 * jeu lisse ne montrerait aucune des lectures que la page existe pour porter.
 *
 * Usage : `pnpm --filter api db:seed [nom-ou-id-du-projet]`
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

const TARGET = process.argv[2] ?? 'Seeded project';

/** La fenêtre de trafic. Assez longue pour que « 30 jours » ait un avant. */
const TRAFFIC_DAYS = 120;

/**
 * L'histoire des abonnements remonte plus loin que le trafic, exprès.
 *
 * Une heatmap de cohortes a besoin de cohortes **mûres** : sans douze mois
 * derrière, le triangle n'a qu'une diagonale et ne dit rien de la rétention.
 * Ces abonnés-là n'ont pas de visite associée — ils sont « antérieurs à
 * l'installation », l'une des trois causes de non-attribution que la carte
 * qualité de la mesure doit pouvoir montrer.
 */
const SUBSCRIPTION_DAYS = 400;

/**
 * Les visites d'un jour moyen, avant saisonnalité et croissance.
 *
 * Réglé pour que les lignes du tableau d'acquisition portent des dizaines de
 * visiteurs plutôt que trois : un taux de conversion calculé sur cinq visiteurs
 * saute de vingt points quand un seul achète, et on passerait le développement
 * à regarder du bruit.
 */
const BASE_VISITS = 105;

const DAY = 86_400_000;
const NOW = new Date();
NOW.setUTCMinutes(0, 0, 0);

/** Générateur déterministe : deux exécutions donnent le même monde. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260917);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (low, high) => low + Math.floor(rand() * (high - low + 1));
const chance = (p) => rand() < p;

function weighted(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rand() * total;

  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }

  return entries[entries.length - 1];
}

/* ------------------------------------------------------------------ monde */

/**
 * Les canaux d'acquisition, avec leur volume **et** leur rendement.
 *
 * `conv` est la probabilité qu'un visiteur du canal finisse par payer. Les
 * écarts sont volontairement grands : `competitor-terms` amène du volume et ne
 * convertit pas, `weekly-digest` amène trois visiteurs et les convertit tous.
 * C'est exactement le contraste que la colonne « revenu par visiteur » existe
 * pour rendre visible, et un jeu uniforme le cacherait.
 */
const CHANNELS = [
  { key: 'direct', weight: 24, conv: 0.03, referrer: null, campaign: null },
  {
    key: 'google',
    weight: 17,
    conv: 0.028,
    referrer: 'https://www.google.com/',
    campaign: null,
  },
  {
    key: 'bing',
    weight: 3,
    conv: 0.021,
    referrer: 'https://www.bing.com/search',
    campaign: null,
  },
  {
    key: 'ddg',
    weight: 2,
    conv: 0.026,
    referrer: 'https://duckduckgo.com/',
    campaign: null,
  },
  {
    key: 'hn',
    weight: 6,
    conv: 0.013,
    referrer: 'https://news.ycombinator.com/',
    campaign: null,
  },
  {
    key: 'reddit',
    weight: 4,
    conv: 0.009,
    referrer: 'https://www.reddit.com/r/SaaS/',
    campaign: null,
  },
  {
    key: 'devto',
    weight: 3,
    conv: 0.016,
    referrer: 'https://dev.to/',
    campaign: null,
  },
  {
    key: 'github',
    weight: 2,
    conv: 0.038,
    referrer: 'https://github.com/',
    campaign: null,
  },
  {
    key: 'brand',
    weight: 7,
    conv: 0.068,
    referrer: 'https://www.google.com/',
    campaign: ['google', 'cpc', 'brand-search'],
  },
  {
    key: 'competitor',
    weight: 10,
    conv: 0.005,
    referrer: 'https://www.google.com/',
    campaign: ['google', 'cpc', 'competitor-terms'],
  },
  {
    key: 'newsletter',
    weight: 2,
    conv: 0.15,
    referrer: null,
    campaign: ['newsletter', 'email', 'weekly-digest'],
  },
  {
    key: 'twitter',
    weight: 5,
    conv: 0.011,
    referrer: 'https://t.co/',
    campaign: ['twitter', 'social', 'founder-thread'],
  },
  {
    key: 'linkedin',
    weight: 4,
    conv: 0.024,
    referrer: 'https://www.linkedin.com/feed/',
    campaign: ['linkedin', 'cpc', 'retargeting-q3'],
  },
  {
    key: 'producthunt',
    weight: 5,
    conv: 0.01,
    referrer: 'https://www.producthunt.com/posts/events-hub',
    campaign: ['producthunt', 'referral', 'launch-day'],
  },
  {
    key: 'partner',
    weight: 3,
    conv: 0.052,
    referrer: 'https://stripe.com/partners',
    campaign: ['stripe', 'partner', 'marketplace'],
  },
];

const SITE = 'https://seeded.example.com';

/** Les pages d'arrivée, par canal : une campagne n'atterrit pas sur un billet. */
const LANDINGS = {
  campaign: ['/pricing', '/', '/lp/analytics-for-founders', '/lp/stripe-revenue'],
  search: [
    '/',
    '/blog/attribution-without-cookies',
    '/blog/mrr-vs-revenue',
    '/docs/quickstart',
    '/pricing',
  ],
  social: [
    '/',
    '/blog/attribution-without-cookies',
    '/changelog',
    '/blog/we-deleted-our-dashboard',
  ],
  direct: ['/', '/pricing', '/docs/quickstart', '/changelog'],
};

const PAGES = [
  '/',
  '/pricing',
  '/docs/quickstart',
  '/docs/sdk/browser',
  '/docs/sdk/server',
  '/integrations/stripe',
  '/changelog',
  '/blog/attribution-without-cookies',
  '/blog/mrr-vs-revenue',
  '/blog/we-deleted-our-dashboard',
  '/about',
  '/signup',
  '/login',
];

const GEO = [
  ['FR', 'Île-de-France', 'Paris', 'fr-FR', 22],
  ['FR', 'Auvergne-Rhône-Alpes', 'Lyon', 'fr-FR', 5],
  ['FR', 'Occitanie', 'Toulouse', 'fr-FR', 3],
  ['US', 'California', 'San Francisco', 'en-US', 12],
  ['US', 'New York', 'New York', 'en-US', 9],
  ['US', 'Texas', 'Austin', 'en-US', 4],
  ['GB', 'England', 'London', 'en-GB', 8],
  ['DE', 'Berlin', 'Berlin', 'de-DE', 6],
  ['DE', 'Bavaria', 'Munich', 'de-DE', 3],
  ['ES', 'Madrid', 'Madrid', 'es-ES', 4],
  ['IT', 'Lazio', 'Rome', 'it-IT', 3],
  ['NL', 'North Holland', 'Amsterdam', 'nl-NL', 3],
  ['BE', 'Brussels', 'Brussels', 'fr-BE', 2],
  ['CH', 'Zurich', 'Zurich', 'de-CH', 2],
  ['CA', 'Ontario', 'Toronto', 'en-CA', 3],
  ['BR', 'São Paulo', 'São Paulo', 'pt-BR', 3],
  ['IN', 'Karnataka', 'Bengaluru', 'en-IN', 4],
  ['AU', 'New South Wales', 'Sydney', 'en-AU', 2],
  ['JP', 'Tokyo', 'Tokyo', 'ja-JP', 2],
  ['SE', 'Stockholm', 'Stockholm', 'sv-SE', 2],
];

/** Navigateur, OS, appareil et taille d'écran voyagent ensemble : un iPhone
 *  n'est pas sous Windows, et c'est le genre d'incohérence qui se voit. */
const CLIENTS = [
  ['Chrome', 'macOS', 'desktop', '1512x982', 16],
  ['Chrome', 'Windows', 'desktop', '1920x1080', 20],
  ['Safari', 'macOS', 'desktop', '1440x900', 9],
  ['Firefox', 'Windows', 'desktop', '1366x768', 4],
  ['Firefox', 'Linux', 'desktop', '1920x1080', 3],
  ['Edge', 'Windows', 'desktop', '1920x1080', 5],
  ['Brave', 'macOS', 'desktop', '1512x982', 2],
  ['Safari', 'iOS', 'mobile', '390x844', 18],
  ['Chrome', 'Android', 'mobile', '412x915', 14],
  ['Chrome', 'iOS', 'mobile', '390x844', 3],
  ['Safari', 'iPadOS', 'tablet', '1024x1366', 3],
];

const BOT_CLIENTS = [
  ['GoogleBot', 'Linux', 'bot'],
  ['Bingbot', 'Linux', 'bot'],
  ['AhrefsBot', 'Linux', 'bot'],
  ['GPTBot', 'Linux', 'bot'],
];

/** Les offres. Le prix est mensuel, en centimes, dans la devise du client. */
const PLANS = [
  { name: 'starter', monthly: 1900, weight: 42 },
  { name: 'pro', monthly: 4900, weight: 38 },
  { name: 'team', monthly: 14900, weight: 16 },
  { name: 'scale', monthly: 39900, weight: 4 },
];

/** Un déploiement tous les quatre jours environ, comme une vraie équipe. */
const RELEASES = Array.from({ length: 30 }, (_, index) => {
  const minor = 1 + Math.floor(index / 3);
  return `v2.${minor}.${index % 3}`;
});

/* ------------------------------------------------------------- génération */

const rows = {
  sessions: [],
  events: [],
  eventTypes: new Set(),
  customers: [],
  subscriptions: [],
  revisions: [],
};

let projectId;

const stableKeyOf = (visitorId) =>
  createHmac('sha256', env.VISITOR_KEY_SECRET)
    .update([projectId, visitorId].join('\n'))
    .digest('hex');

/**
 * La clé du mode dérivé, qui **change chaque jour**.
 *
 * Elle n'a pas à valoir celle que l'API calculerait — personne ne la recalcule
 * à la lecture. Ce qui doit être vrai, c'est sa forme : 64 hexa, et une valeur
 * différente pour le même visiteur d'un jour à l'autre. C'est cette rotation
 * qui fait qu'un visiteur non consenti compte double s'il revient demain, et
 * c'est un fait du produit, pas un défaut du jeu.
 */
const rotatingKeyOf = (visitorId, at) =>
  createHmac('sha256', 'seed-rotation')
    .update(`${visitorId}\n${at.toISOString().slice(0, 10)}`)
    .digest('hex');

const addEvent = (event) => {
  rows.eventTypes.add(event.type);
  rows.events.push(event);
};

/** Le trafic du jour : tendance à la hausse, creux le week-end, pic PH. */
function trafficOf(dayIndex, launchDay) {
  const date = new Date(NOW.getTime() - (TRAFFIC_DAYS - 1 - dayIndex) * DAY);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const growth = 0.55 + (dayIndex / TRAFFIC_DAYS) * 0.9;
  const noise = 0.8 + rand() * 0.45;
  const spike = dayIndex === launchDay ? 7 : dayIndex === launchDay + 1 ? 2.6 : 1;

  return {
    date,
    visits: Math.round(BASE_VISITS * growth * noise * (weekend ? 0.55 : 1) * spike),
    isLaunch: dayIndex === launchDay || dayIndex === launchDay + 1,
  };
}

function landingFor(channel) {
  if (channel.campaign) return pick(LANDINGS.campaign);
  if (['google', 'bing', 'ddg'].includes(channel.key)) return pick(LANDINGS.search);
  if (channel.key === 'direct') return pick(LANDINGS.direct);

  return pick(LANDINGS.social);
}

/**
 * Une visite : la session, ses vues, et ce qui s'y est passé.
 *
 * L'entonnoir est porté par des types métier (`pricing_viewed`,
 * `checkout_started`) plutôt que déduit des chemins : c'est ce que ferait un
 * vrai client, et c'est ce que la carte Funnel lira.
 */
function visit(visitor, at, { first, converting, buying }) {
  const sessionId = randomUUID();
  const durable = visitor.consent === true;
  const visitorKey = durable
    ? visitor.stableKey
    : rotatingKeyOf(visitor.id, at);

  rows.sessions.push({
    id: sessionId,
    visitorKey,
    startedAt: at,
    country: visitor.geo[0],
    region: visitor.geo[1],
    city: visitor.geo[2],
    browser: visitor.client[0],
    os: visitor.client[1],
    device: visitor.client[2],
    isBot: visitor.isBot,
    campaign: first ? visitor.channel.campaign : null,
    consent: visitor.consent,
  });

  // Posée seulement en mode durable : c'est l'invariant du socle, et c'est lui
  // qui décide quels paiements seront corrélables à une visite.
  const eventVisitorKey = durable ? visitor.stableKey : null;

  const entry = first ? visitor.landing : pick(PAGES);
  const depth = visitor.isBot
    ? between(1, 2)
    : buying
      ? between(4, 9)
      : converting
        ? between(3, 7)
        : chance(0.42)
          ? 1
          : between(2, 5);

  const path = [entry];
  while (path.length < depth) path.push(pick(PAGES));

  let clock = at.getTime();

  path.forEach((page, index) => {
    const url = `${SITE}${page}`;

    addEvent({
      type: 'page_view',
      occurredAt: new Date(clock),
      sessionId,
      visitorKey: eventVisitorKey,
      source: 'browser',
      attributes: {
        'page.path': page,
        'page.url': url,
        'sdk.version': '0.4.2',
        'screen.size': visitor.client[3] ?? null,
        'navigator.language': visitor.geo[3],
        // Le referrer n'est présent qu'à l'arrivée : ensuite le navigateur
        // renvoie notre propre origine, et `entry-source` le classerait en
        // navigation interne.
        ...(index === 0 && first && visitor.channel.referrer
          ? { 'page.referrer': visitor.channel.referrer }
          : {}),
        ...(index > 0 ? { 'page.referrer': `${SITE}${path[index - 1]}` } : {}),
      },
      properties: {},
    });

    const dwell = visitor.isBot ? between(1, 4) : between(8, 210);
    clock += dwell * 1000;

    if (page === '/pricing' && (converting || chance(0.2))) {
      addEvent({
        type: 'pricing_viewed',
        occurredAt: new Date(clock),
        sessionId,
        visitorKey: eventVisitorKey,
        source: 'browser',
        attributes: {},
        properties: { 'plan.highlighted': weighted(PLANS).name },
      });
      clock += 4000;
    }

    if (!visitor.isBot && chance(0.14)) {
      addEvent({
        type: pick(['docs_searched', 'feature_used', 'plan_compared', 'click']),
        occurredAt: new Date(clock),
        sessionId,
        visitorKey: eventVisitorKey,
        source: 'browser',
        attributes: {},
        properties: { 'page.path': page },
      });
      clock += 3000;
    }

    addEvent({
      type: 'page_leave',
      occurredAt: new Date(clock),
      sessionId,
      visitorKey: eventVisitorKey,
      source: 'browser',
      attributes: { 'page.path': page },
      properties: { 'leave.reason': index === path.length - 1 ? 'pagehide' : 'page_hidden' },
    });

    clock += between(1, 6) * 1000;
  });

  if (buying) {
    addEvent({
      type: 'checkout_started',
      occurredAt: new Date(clock),
      sessionId,
      visitorKey: eventVisitorKey,
      source: 'browser',
      attributes: {},
      properties: { 'plan.name': visitor.plan?.name ?? 'pro' },
    });
    clock += 2000;

    // Le clic sortant vers Stripe : la seule sortie observable, et ce qui rend
    // lisible « parti payer mais jamais payé » quand aucun paiement ne suit.
    addEvent({
      type: 'outbound_click',
      occurredAt: new Date(clock),
      sessionId,
      visitorKey: eventVisitorKey,
      source: 'browser',
      attributes: {},
      properties: {
        'link.origin': 'https://checkout.stripe.com',
        'element.href': 'https://checkout.stripe.com/c/pay/cs_test_seed',
      },
    });
  } else if (!visitor.isBot && chance(0.04)) {
    addEvent({
      type: 'outbound_click',
      occurredAt: new Date(clock),
      sessionId,
      visitorKey: eventVisitorKey,
      source: 'browser',
      attributes: {},
      properties: {
        'link.origin': pick([
          'https://github.com',
          'https://checkout.stripe.com',
          'https://status.example.com',
        ]),
      },
    });
  }

  if (converting && chance(0.5)) {
    addEvent({
      type: 'signup_completed',
      occurredAt: new Date(clock + 5000),
      sessionId,
      visitorKey: eventVisitorKey,
      source: 'browser',
      attributes: {},
      properties: { 'signup.method': pick(['email', 'google', 'github']) },
    });
  }
}

function buildTraffic() {
  const launchDay = TRAFFIC_DAYS - 58;
  const visitors = [];
  let counter = 0;
  // Les revenants : on garde les visiteurs qui peuvent revenir un autre jour.
  const returning = [];

  for (let day = 0; day < TRAFFIC_DAYS; day += 1) {
    const { date, visits, isLaunch } = trafficOf(day, launchDay);

    for (let n = 0; n < visits; n += 1) {
      const at = new Date(
        date.getTime() + between(6, 22) * 3_600_000 + between(0, 59) * 60_000,
      );

      // Un tiers des visites d'un jour sont des retours, quand il y a de quoi.
      if (returning.length > 40 && chance(0.3)) {
        const back = returning[Math.floor(rand() * returning.length)];
        visit(back, at, { first: false, converting: back.converts, buying: false });
        continue;
      }

      counter += 1;
      const isBot = chance(0.045);
      const channel = isLaunch && chance(0.65)
        ? CHANNELS.find((c) => c.key === 'producthunt')
        : weighted(CHANNELS);

      const visitor = {
        id: `v_${String(counter).padStart(5, '0')}`,
        channel,
        landing: landingFor(channel),
        geo: weighted(GEO.map((g) => ({ weight: g[4], g }))).g,
        client: isBot
          ? [...pick(BOT_CLIENTS), null]
          : weighted(CLIENTS.map((c) => ({ weight: c[4], c }))).c,
        isBot,
        // Trois états, pas deux. `null` = jamais demandé : l'analytics est
        // exemptée, seul le croisement avec le revenu demande un cookie.
        consent: isBot ? null : chance(0.7) ? true : chance(0.45) ? false : null,
        firstSeen: at,
      };

      visitor.stableKey = stableKeyOf(visitor.id);
      visitor.converts = !isBot && chance(channel.conv);
      visitor.plan = visitor.converts ? weighted(PLANS) : null;

      visitors.push(visitor);
      if (!isBot) returning.push(visitor);

      const buying = visitor.converts && chance(0.55);
      visit(visitor, at, { first: true, converting: visitor.converts, buying });

      // Les acheteurs qui n'ont pas payé à la première visite reviennent le
      // faire : c'est ce qui donne du corps à « sessions avant achat ».
      if (visitor.converts && !buying) {
        const later = new Date(at.getTime() + between(1, 12) * DAY);
        if (later < NOW) {
          visit(visitor, later, { first: false, converting: true, buying: true });
        }
      }
    }
  }

  return visitors;
}

/* --------------------------------------------------------------- Stripe */

const CURRENCIES = [
  { code: 'eur', weight: 58 },
  { code: 'usd', weight: 34 },
  { code: 'gbp', weight: 8 },
];

/**
 * Le monde Stripe, construit **à partir** des visiteurs qui ont converti.
 *
 * Trois populations, parce que la carte « qualité de la mesure » a trois causes
 * distinctes à montrer et qu'elles n'appellent pas la même action :
 * le client attribué (visite connue, consentement donné, metadata posée), le
 * client qui a refusé le cookie de croisement, et le client sans metadata —
 * seul cas réparable. S'y ajoutent les abonnés antérieurs à l'installation,
 * qui n'ont aucune visite à trouver.
 */
function buildStripe(visitors) {
  const paying = visitors.filter((v) => v.converts);
  let counter = 0;
  const events = [];

  const newCustomer = (visitor, startedAt, currency, plan) => {
    counter += 1;
    const customerId = `cus_Seed${String(counter).padStart(5, '0')}`;
    // Le visiteur n'est appairé que si le croisement a été consenti : sans lui
    // la metadata n'a jamais été posée, et le lien n'existe pas.
    const linked = visitor && visitor.consent === true && chance(0.88);

    if (linked) {
      rows.customers.push({ customerId, visitorId: visitor.id, learnedAt: startedAt });
    }

    return {
      customerId,
      visitorKey: linked ? visitor.stableKey : null,
      currency,
      plan,
      startedAt,
    };
  };

  const emit = (type, at, customer, extra) => {
    events.push({
      type,
      occurredAt: at,
      sessionId: null,
      visitorKey: customer.visitorKey,
      source: 'server',
      attributes: {},
      properties: {
        'stripe.event.id': `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        'stripe.customer.id': customer.customerId,
        'stripe.livemode': false,
        ...extra,
      },
    });
  };

  /** Un paiement, et le bruit qui l'accompagne réellement chez Stripe. */
  const invoice = (customer, at, amount, reason, subscriptionId) => {
    const invoiceId = `in_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    const money = { 'payment.amount': amount, 'payment.currency': customer.currency };
    const type =
      reason === 'subscription_create'
        ? 'stripe.subscription.started'
        : reason === 'subscription_cycle'
          ? 'stripe.subscription.renewed'
          : 'stripe.subscription.changed';

    // La ligne qui compte : une facture, un événement de revenu.
    emit(type, at, customer, {
      ...money,
      'stripe.event.type': 'invoice.paid',
      'stripe.object.id': invoiceId,
      'stripe.billing_reason': reason,
      'stripe.subscription.id': subscriptionId,
    });

    // Le bruit : même montant, types hors `REVENUE_TYPES`. Il est là pour que
    // l'explorateur d'événements ressemble à la réalité — et pour qu'on voie
    // que la somme ne bouge pas quand on l'ajoute.
    emit('stripe.invoice.created', new Date(at.getTime() - 4000), customer, {
      'stripe.event.type': 'invoice.created',
      'stripe.object.id': invoiceId,
    });
    emit('stripe.charge.succeeded', new Date(at.getTime() + 1500), customer, {
      ...money,
      'stripe.event.type': 'charge.succeeded',
      'stripe.object.id': `ch_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
    });
    emit('stripe.payment_intent.succeeded', new Date(at.getTime() + 2000), customer, {
      ...money,
      'stripe.event.type': 'payment_intent.succeeded',
      'stripe.object.id': `pi_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
    });
  };

  const subscribe = (customer, { startedAt, endedAt, upgradeAt }) => {
    const id = randomUUID();
    const stripeId = `sub_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    let monthly = customer.plan.monthly;

    emit('stripe.customer.created', new Date(startedAt.getTime() - 60_000), customer, {
      'stripe.event.type': 'customer.created',
      'stripe.object.id': customer.customerId,
    });

    invoice(customer, startedAt, monthly, 'subscription_create', stripeId);
    rows.revisions.push({
      subscriptionId: id,
      observedAt: startedAt,
      currency: customer.currency,
      before: null,
      after: monthly,
      status: 'active',
    });

    // Les renouvellements mensuels, jusqu'à la fin ou jusqu'à aujourd'hui.
    const stop = endedAt ?? NOW;
    let cycle = new Date(startedAt);
    let changed = false;

    for (;;) {
      cycle = new Date(cycle.getTime() + 30.4375 * DAY);
      if (cycle >= stop) break;

      if (upgradeAt && !changed && cycle >= upgradeAt) {
        const before = monthly;
        // Une montée en gamme, ou une descente : le waterfall du MRR a besoin
        // des deux, et seule l'expansion serait un mensonge par omission.
        monthly = chance(0.75)
          ? Math.round(monthly * (1.4 + rand() * 1.4))
          : Math.round(monthly * 0.6);
        changed = true;

        invoice(customer, cycle, monthly, 'subscription_update', stripeId);
        rows.revisions.push({
          subscriptionId: id,
          observedAt: cycle,
          currency: customer.currency,
          before,
          after: monthly,
          status: 'active',
        });
        continue;
      }

      invoice(customer, cycle, monthly, 'subscription_cycle', stripeId);
    }

    if (endedAt) {
      emit('stripe.customer.subscription.deleted', endedAt, customer, {
        'stripe.event.type': 'customer.subscription.deleted',
        'stripe.object.id': stripeId,
      });
      rows.revisions.push({
        subscriptionId: id,
        observedAt: endedAt,
        currency: customer.currency,
        before: monthly,
        after: 0,
        status: 'canceled',
      });
    }

    rows.subscriptions.push({
      id,
      stripeId,
      customerId: customer.customerId,
      status: endedAt ? 'canceled' : 'active',
      currency: customer.currency,
      createdAt: startedAt,
      startDate: startedAt,
      canceledAt: endedAt,
      endedAt,
      collectionMethod: 'charge_automatically',
    });
  };

  // 1. Les abonnés antérieurs à l'installation : aucune visite à trouver.
  for (let n = 0; n < 46; n += 1) {
    const startedAt = new Date(
      NOW.getTime() - between(TRAFFIC_DAYS + 5, SUBSCRIPTION_DAYS) * DAY,
    );
    const customer = newCustomer(
      null,
      startedAt,
      weighted(CURRENCIES).code,
      weighted(PLANS),
    );
    const churns = chance(0.34);

    subscribe(customer, {
      startedAt,
      endedAt: churns
        ? new Date(
            Math.min(
              NOW.getTime() - DAY,
              startedAt.getTime() + between(2, 13) * 30.4375 * DAY,
            ),
          )
        : null,
      upgradeAt: chance(0.3)
        ? new Date(startedAt.getTime() + between(2, 8) * 30.4375 * DAY)
        : null,
    });
  }

  // 2. Ceux qui sont venus par le site pendant la fenêtre : les seuls
  //    attribuables, et donc les seuls qui feront vivre la carte Acquisition.
  for (const visitor of paying) {
    const startedAt = new Date(
      visitor.firstSeen.getTime() + between(0, 14) * DAY + between(1, 20) * 3_600_000,
    );
    if (startedAt >= NOW) continue;

    const currency =
      visitor.geo[0] === 'US' ? 'usd' : visitor.geo[0] === 'GB' ? 'gbp' : 'eur';
    const customer = newCustomer(visitor, startedAt, currency, visitor.plan);

    // Une poignée d'achats ponctuels plutôt qu'un abonnement : le type existe
    // pour eux, et sans eux il ne serait jamais exercé.
    if (chance(0.12)) {
      emit('stripe.payment.one_time', startedAt, customer, {
        'payment.amount': pick([4900, 9900, 19900, 29900]),
        'payment.currency': currency,
        'stripe.event.type': 'checkout.session.completed',
        'stripe.checkout.mode': 'payment',
        'stripe.object.id': `cs_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
      });
      continue;
    }

    subscribe(customer, {
      startedAt,
      endedAt: chance(0.16)
        ? new Date(
            Math.min(
              NOW.getTime() - DAY,
              startedAt.getTime() + between(1, 4) * 30.4375 * DAY,
            ),
          )
        : null,
      upgradeAt: chance(0.22)
        ? new Date(startedAt.getTime() + between(1, 3) * 30.4375 * DAY)
        : null,
    });
  }

  for (const event of events) addEvent(event);
}

function buildDeployments() {
  RELEASES.forEach((tag, index) => {
    const at = new Date(
      NOW.getTime() - (TRAFFIC_DAYS - 4 - index * 4) * DAY + 10 * 3_600_000,
    );
    if (at >= NOW) return;

    addEvent({
      type: 'deployment',
      occurredAt: at,
      sessionId: null,
      visitorKey: null,
      source: 'server',
      attributes: {},
      properties: {
        'deploy.env': 'production',
        'release.tag': tag,
        'deploy.duration_ms': between(48_000, 240_000),
      },
    });
  });
}

/* ------------------------------------------------------------- écriture */

async function chunked(client, table, columns, values, rowSize) {
  const perBatch = Math.max(1, Math.floor(2000 / rowSize));

  for (let start = 0; start < values.length; start += perBatch) {
    const slice = values.slice(start, start + perBatch);
    const params = [];
    const tuples = slice.map((row) => {
      const marks = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${marks.join(',')})`;
    });

    await client.query(
      `insert into ${table} (${columns.join(',')}) values ${tuples.join(',')}`,
      params,
    );
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const found = await client.query(
      `select id, name from projects where name = $1 or id::text = $1 limit 1`,
      [TARGET],
    );

    if (found.rowCount === 0) throw new Error(`Projet introuvable : ${TARGET}`);
    projectId = found.rows[0].id;
    console.log(`→ ${found.rows[0].name} (${projectId})`);

    const visitors = buildTraffic();
    buildStripe(visitors);
    buildDeployments();

    rows.events.sort((a, b) => a.occurredAt - b.occurredAt);

    await client.query('begin');

    // Table rase : le seeder est rejouable, et deux passes empilées rendraient
    // des chiffres que plus personne ne saurait expliquer.
    for (const table of [
      'events',
      'sessions',
      'event_types',
      'stripe_subscription_revisions',
      'stripe_subscriptions',
      'stripe_customers',
      'integrations',
    ]) {
      await client.query(`delete from ${table} where project_id = $1`, [projectId]);
    }

    await client.query(
      `insert into integrations (project_id, provider, external_account_id, scope, livemode, connected_at)
       values ($1, 'stripe', 'acct_SeedDemo0001', 'read_only', false, $2)`,
      [projectId, new Date(NOW.getTime() - TRAFFIC_DAYS * DAY)],
    );

    await chunked(
      client,
      'event_types',
      ['project_id', 'name'],
      [...rows.eventTypes].map((name) => [projectId, name]),
      2,
    );

    await chunked(
      client,
      'sessions',
      ['id', 'project_id', 'visitor_key', 'started_at', 'country_code', 'region',
       'city', 'browser', 'os', 'device_type', 'is_bot', 'campaign_source',
       'campaign_medium', 'campaign_name', 'consent'],
      rows.sessions.map((s) => [
        s.id, projectId, s.visitorKey, s.startedAt, s.country, s.region, s.city,
        s.browser, s.os, s.device, s.isBot,
        s.campaign?.[0] ?? null, s.campaign?.[1] ?? null, s.campaign?.[2] ?? null,
        s.consent,
      ]),
      15,
    );

    await chunked(
      client,
      'events',
      ['project_id', 'type', 'occurred_at', 'attributes', 'properties', 'source',
       'session_id', 'visitor_key'],
      rows.events.map((e) => [
        projectId, e.type, e.occurredAt,
        JSON.stringify(dropUndefined(e.attributes)),
        JSON.stringify(dropUndefined(e.properties)),
        e.source, e.sessionId, e.visitorKey,
      ]),
      8,
    );

    await chunked(
      client,
      'stripe_customers',
      ['project_id', 'customer_id', 'visitor_id', 'learned_at'],
      rows.customers.map((c) => [projectId, c.customerId, c.visitorId, c.learnedAt]),
      4,
    );

    await chunked(
      client,
      'stripe_subscriptions',
      ['id', 'project_id', 'stripe_id', 'customer_id', 'status', 'currency',
       'created_at', 'start_date', 'cancel_at_period_end', 'canceled_at',
       'ended_at', 'collection_method', 'livemode', 'observed_at'],
      rows.subscriptions.map((s) => [
        s.id, projectId, s.stripeId, s.customerId, s.status, s.currency,
        s.createdAt, s.startDate, false, s.canceledAt, s.endedAt,
        s.collectionMethod, false, s.endedAt ?? NOW,
      ]),
      14,
    );

    await chunked(
      client,
      'stripe_subscription_revisions',
      ['project_id', 'subscription_id', 'observed_at', 'currency',
       'monthly_before', 'monthly_after', 'status'],
      rows.revisions.map((r) => [
        projectId, r.subscriptionId, r.observedAt, r.currency,
        r.before, r.after, r.status,
      ]),
      7,
    );

    await client.query('commit');

    console.log(
      `✓ ${rows.sessions.length} sessions · ${rows.events.length} events · ` +
        `${rows.eventTypes.size} types · ${rows.subscriptions.length} abonnements · ` +
        `${rows.customers.length} clients appairés · ${rows.revisions.length} révisions`,
    );
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/** `undefined` n'a pas de représentation JSON : il ferait disparaître la clé
 *  d'un côté et écrirait `null` de l'autre selon le chemin. Autant trancher. */
function dropUndefined(bag) {
  return Object.fromEntries(
    Object.entries(bag).filter(([, value]) => value !== undefined && value !== null),
  );
}

await main();

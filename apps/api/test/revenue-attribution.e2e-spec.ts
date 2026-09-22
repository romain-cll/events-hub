import { revenueAttributionPageSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CoreService } from '../src/core/core.service';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { sessions } from '../src/database/schema';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  cookiesOf,
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  type SignedUpUser,
  type TestProject,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * D'où vient le revenu — de la visite au paiement, sur quatre axes à la fois.
 *
 * Ce que seul un vrai Postgres montre ici : les deux `lateral` enchaînés qui
 * remontent d'un paiement à la **première visite** de son visiteur, puis au
 * **premier événement** de cette visite — là où vivent le referrer et le chemin
 * d'entrée, dans un sac que le Core ne sait pas lire mais sait grouper.
 *
 * Éprouvé aussi : le cumul des devises sur le **règlement** recopié de Stripe,
 * le repli des referrers en hôtes puis en natures, et le fait qu'un paiement
 * sans parcours ne soit pas rangé sous « direct ».
 *
 * Les paiements sont ingérés par le Core, pas par HTTP : `POST /v1/events` ne
 * permet pas de désigner un visiteur depuis une source serveur — l'identité y
 * vient du cookie. Le chemin testé reste le vrai, c'est exactement l'appel que
 * `features/stripe` fait en traitant un webhook.
 */

const PREMIERE_VISITE = new Date('2026-07-01T10:00:00.000Z');
const SECONDE_VISITE = new Date('2026-07-01T14:00:00.000Z');

/** La fenêtre de lecture : elle ne contient que les paiements. */
const FENETRE = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-09-01T00:00:00.000Z',
};

const PAIEMENT = new Date('2026-08-10T12:00:00.000Z');

const NAVIGATEUR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const COOKIE = '__Host-eh_vid';

/** La devise du compte connecté : celle dans laquelle tout est réglé. */
const REGLEMENT = 'eur';

/** Le taux que « Stripe » aurait appliqué. Recopié, jamais recalculé. */
const TAUX = 0.92;

const NOUVEAU = 'stripe.subscription.started';
const RENOUVELLEMENT = 'stripe.subscription.renewed';
const PONCTUEL = 'stripe.payment.one_time';

interface Visite {
  campaign?: Record<string, string>;
  referrer?: string;
  path?: string;
  visitorId?: string;
  at?: Date;
}

describe('attribution du revenu (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let core: CoreService;
  let projet: TestProject;
  let lecteur: SignedUpUser;

  /** Une visite consentie ; rend l'identifiant durable que le hub a posé. */
  const visiter = async ({
    campaign,
    referrer,
    path = '/',
    visitorId,
    at = PREMIERE_VISITE,
  }: Visite): Promise<string> => {
    const envoi = request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', NAVIGATEUR);

    if (visitorId) envoi.set('Cookie', `${COOKIE}=${visitorId}`);

    const response = await envoi
      .send({
        apiKey: projet.apiKey,
        type: 'page_view',
        occurredAt: at.toISOString(),
        attributes: {
          'page.path': path,
          ...(referrer ? { 'page.referrer': referrer } : {}),
        },
        properties: {},
        consent: true,
        ...(campaign ? { campaign } : {}),
      })
      .expect(201);

    const pose = cookiesOf(response).find((value) => value.startsWith(COOKIE));

    return visitorId ?? /=([^;]+)/.exec(pose ?? '')?.[1] ?? '';
  };

  /**
   * Un paiement rapporté par un serveur, comme `features/stripe` le fait.
   *
   * Le **règlement** est écrit à côté du montant facturé, parce que c'est ce
   * que les lectures somment : `features/stripe` le recopie de la transaction
   * de solde à l'ingestion, et un paiement sans lui n'est pas convertible.
   * `settle: false` produit exactement ce cas.
   */
  const encaisser = (
    type: string,
    amount: number,
    currency: string,
    visitorId?: string,
    settle = true,
  ) =>
    core.ingest({
      projectId: projet.id,
      type,
      occurredAt: PAIEMENT,
      attributes: {},
      properties: {
        'payment.amount': amount,
        'payment.currency': currency,
        ...(settle
          ? {
              'payment.settled':
                currency === REGLEMENT ? amount : Math.round(amount * TAUX),
              'payment.settled_currency': REGLEMENT,
              'payment.exchange_rate': currency === REGLEMENT ? null : TAUX,
            }
          : {}),
      },
      source: 'server',
      visitorId,
    });

  const lire = async (query: Record<string, string> = {}) => {
    const page = expectMatchesContract(
      (
        await request(app.getHttpServer())
          .get(`/v1/projects/${projet.id}/revenue/attribution`)
          .set('Cookie', lecteur.cookies)
          .query({ ...FENETRE, ...query })
          .expect(200)
      ).body,
      revenueAttributionPageSchema,
    );

    // Les clés sont optionnelles — une absente veut dire « pas demandée ». Les
    // cas qui suivent demandent les axes par défaut, donc les quatre sont là :
    // l'affirmer une fois ici évite un `?.` sur chaque assertion.
    if (!page.campaign || !page.source || !page.referrer || !page.landing) {
      throw new Error('Les quatre axes par défaut devraient être rendus.');
    }

    return {
      ...page,
      campaign: page.campaign,
      source: page.source,
      referrer: page.referrer,
      landing: page.landing,
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    core = app.get(CoreService);

    projet = await createProject(db, { name: 'e2e attribution' });
    lecteur = await signUp(app, 'Lecteur attribution');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    // Deux visites du même visiteur, deux campagnes, et c'est la première qui
    // doit gagner : quatre heures les séparent, donc deux sessions.
    const avecCampagne = await visiter({
      campaign: { source: 'google', medium: 'cpc', name: 'rentree' },
      referrer: 'https://www.google.fr/',
      path: '/pricing',
    });

    await visiter({
      campaign: { source: 'bing', medium: 'organic' },
      referrer: 'https://www.bing.com/',
      visitorId: avecCampagne,
      at: SECONDE_VISITE,
    });

    // Un second moteur, même famille : `google.com` et `google.fr` doivent se
    // replier en une seule ligne de provenance.
    const autreGoogle = await visiter({
      referrer: 'https://www.google.com/',
      path: '/docs',
    });

    // Un visiteur connu, venu sans campagne ni referrer : direct.
    const direct = await visiter({ path: '/' });

    // Le pays vient de la base GeoIP, absente en test : on le pose à la main,
    // c'est la seule façon d'éprouver cet axe-là.
    await db
      .update(sessions)
      .set({ countryCode: 'FR' })
      .where(eq(sessions.projectId, projet.id));

    await encaisser(NOUVEAU, 2000, 'eur', avecCampagne);
    await encaisser(NOUVEAU, 1500, 'usd', avecCampagne);
    await encaisser(RENOUVELLEMENT, 900, 'eur', avecCampagne);
    await encaisser(PONCTUEL, 700, 'eur', autreGoogle);
    await encaisser(NOUVEAU, 500, 'eur', direct);

    // Un visiteur qu'aucune visite ne porte, et un paiement sans identité :
    // client d'avant l'installation, et consentement refusé.
    await encaisser(NOUVEAU, 700, 'eur', 'inconnu-au-bataillon');
    await encaisser(NOUVEAU, 300, 'eur');

    // Et un paiement écrit avant que la recopie du règlement existe : il compte
    // comme paiement, il ne compte dans aucun total.
    await encaisser(PONCTUEL, 4200, 'eur', direct, false);
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  it('range le paiement sous la campagne de la première visite', async () => {
    const page = await lire();

    // `bing` est la seconde visite du même visiteur : elle ne doit apparaître
    // nulle part. L'acquisition est antérieure à la fenêtre, et c'est le point
    // — la fenêtre choisit les paiements, pas l'ancienneté qu'on leur reconnaît.
    // 2000 + 900 encaissés en euros, 1500 en dollars réglés 1380 : une seule
    // ligne, parce que c'est le règlement qu'on somme et qu'il est dans une
    // seule devise.
    expect(page.campaign.rows).toEqual([
      expect.objectContaining({
        campaign: { source: 'google', medium: 'cpc', name: 'rentree' },
        currency: 'eur',
        amount: 4280,
        payments: 3,
      }),
    ]);
  });

  it('additionne les cinq types sans choisir de `kind`', async () => {
    const page = await lire();

    // 2000 (started) + 900 (renewed) sur la même campagne : les types sont
    // disjoints, donc leur somme est le revenu de cette campagne. Il n'y a plus
    // de paramètre à passer pour choisir lequel compte.
    expect(page.eventTypes).toContain(NOUVEAU);
    expect(page.eventTypes).toContain(PONCTUEL);
    expect(page.campaign.rows[0].payments).toBe(3);
  });

  it('replie les referrers d’un même moteur en un hôte', async () => {
    const page = await lire();
    const moteurs = page.referrer.rows.filter(
      (row) => row.source.name === 'google' && row.currency === 'eur',
    );

    // `google.fr` et `google.com` sont deux lignes pour Postgres : 4280 € du
    // premier visiteur, 700 € du second. Une seule pour le lecteur.
    expect(moteurs).toHaveLength(1);
    expect(moteurs[0].amount).toBe(4980);
    expect(moteurs[0].source.kind).toBe('search');
  });

  it('range une visite balisée sous Campaign, pas sous Search', async () => {
    const page = await lire();

    // Le premier visiteur arrive de `google.fr` **avec** des paramètres de
    // campagne. Le referrer seul le rangerait en `search`, ce qui ferait lire
    // « la recherche m'apporte 4980 € » en y comptant du trafic acheté.
    const natures = Object.fromEntries(
      page.source.rows
        .filter((row) => row.currency === 'eur')
        .map((row) => [row.nature, row.amount]),
    );

    expect(natures).toEqual({ campaign: 4280, search: 700 });
  });

  it('rend les quatre répartitions dans la même réponse', async () => {
    const page = await lire();

    // Les quatre voient les mêmes paiements, donc le même total réglé — ce qui
    // change est la façon de les ranger. C'est l'intérêt d'une seule route :
    // quatre appels pourraient se contredire.
    const euros = (rows: { currency: string | null; amount: number }[]) =>
      rows
        .filter((row) => row.currency === 'eur')
        .reduce((sum, row) => sum + row.amount, 0);

    const total = (axis: {
      rows: { currency: string | null; amount: number }[];
      direct: { currency: string | null; amount: number }[];
      unattributed: { currency: string | null; amount: number }[];
    }) => euros(axis.rows) + euros(axis.direct) + euros(axis.unattributed);

    expect(total(page.campaign)).toBe(6480);
    expect(total(page.source)).toBe(6480);
    expect(total(page.referrer)).toBe(6480);
    expect(total(page.landing)).toBe(6480);
  });

  it('range la page d’entrée de la première visite', async () => {
    const page = await lire();

    // `/pricing` et non `/` : c'est la page par laquelle ce visiteur est
    // arrivé, pas celle qu'il a vue ensuite.
    expect(page.landing.rows.map((row) => row.label)).toEqual(
      expect.arrayContaining(['/pricing', '/docs', '/']),
    );
  });

  it('sépare le visiteur connu sans campagne du paiement sans parcours', async () => {
    const page = await lire();

    // Connu, venu sans campagne : ce n'est pas un trou de mesure.
    expect(page.campaign.direct).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'eur', amount: 1200 }),
      ]),
    );

    // Deux paiements qu'aucune visite ne réclame — un client d'avant
    // l'installation, un refus de consentement.
    expect(page.campaign.unattributed).toEqual([
      expect.objectContaining({ currency: 'eur', amount: 1000, payments: 2 }),
    ]);
  });

  it('cumule les devises au taux de Stripe, sans en inventer un', async () => {
    const page = await lire();

    // La règle n'a pas changé de nature, seulement de colonne : on ne convertit
    // toujours rien nous-mêmes. Ce qui est sommé est le montant **réglé**, que
    // Stripe a converti pour se payer et qu'on a recopié — d'où une seule
    // devise en sortie, et un total qui reste le sien.
    expect(page.campaign.rows.map((row) => [row.currency, row.amount])).toEqual(
      [['eur', 4280]],
    );
  });

  it('compte les paiements non convertibles sans les fondre dans le total', async () => {
    const page = await lire();

    // Un paiement écrit avant que la recopie du règlement existe. Le ranger
    // sous zéro euro le ferait disparaître ; le convertir nous-mêmes rendrait un
    // chiffre que Stripe ne confirmerait pas. Il sort donc sans devise, avec son
    // compte — « il existe, et cette lecture ne sait pas le convertir ».
    expect(page.campaign.direct).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: null, amount: 0, payments: 1 }),
      ]),
    );
  });

  it('accepte les filtres déclarés sans qu’ils changent quoi que ce soit', async () => {
    const [sans, avec] = await Promise.all([
      lire(),
      lire({ country: 'FR', landing: '/pricing' }),
    ]);

    // Ils sont posés pour que la page puisse se filtrer plus tard sans rouvrir
    // le contrat. Tant qu'ils n'agissent pas, ce test est ce qui empêche de
    // croire qu'ils agissent.
    expect(avec).toEqual(sans);
  });

  it('ne rend que les axes demandés', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/attribution`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, axes: 'campaign,browser' })
      .expect(200);

    const page = expectMatchesContract(
      response.body,
      revenueAttributionPageSchema,
    );

    // Une clé absente veut dire « pas demandée », jamais « calculée et vide » :
    // chaque axe est une passe SQL, et les rendre tous ferait payer sept
    // agrégations à qui en affiche deux.
    expect(page.campaign).toBeDefined();
    expect(page.browser).toBeDefined();
    expect(page.source).toBeUndefined();
    expect(page.country).toBeUndefined();
  });

  it('range aussi les paiements par navigateur', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/attribution`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, axes: 'browser' })
      .expect(200);

    const page = expectMatchesContract(
      response.body,
      revenueAttributionPageSchema,
    );

    // Toutes les visites de cette suite portent le même User-Agent : une seule
    // ligne réglée, et c'est la preuve que l'axe lit bien la colonne de la
    // visite. La seconde est le paiement non convertible, sans devise.
    expect(page.browser?.rows).toEqual([
      expect.objectContaining({ label: 'Chrome', currency: 'eur' }),
      expect.objectContaining({ label: 'Chrome', currency: null, amount: 0 }),
    ]);
  });

  it('refuse un paramètre qu’il n’applique pas', async () => {
    await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/attribution`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, interval: 'day' })
      .expect(400);
  });
});

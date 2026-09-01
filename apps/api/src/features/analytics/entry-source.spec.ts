import { sourceOf, type Source } from './entry-source';
import {
  LEAVE_TYPE,
  sessionsOf,
  VIEW_TYPE,
  type ActivityEvent,
} from './sessions';

const SITE = 'https://shop.test';

let horloge = 0;

/** Un instant croissant, pour que l'ordre des sessions soit celui de l'écriture. */
function tick(): Date {
  horloge += 60_000;

  return new Date(Date.UTC(2026, 7, 22, 10) + horloge);
}

beforeEach(() => {
  horloge = 0;
});

function event(
  session: string,
  type: string,
  attributes: Record<string, unknown> = {},
): ActivityEvent {
  const occurredAt = tick();

  // Le début persisté vaut l'instant de l'événement : ce module ne lit pas
  // `startedAt`, mais `sessionsOf` le demande.
  return {
    sessionId: session,
    sessionStartedAt: occurredAt,
    // Un visiteur par session : ce module ne lit pas l'alias, et lui donner une
    // valeur distincte par session évite de suggérer un lien qui ne joue aucun
    // rôle ici.
    visitorAlias: session,
    type,
    occurredAt,
    attributes,
    // Ce module ne lit pas les propriétés : le sac vide dit qu'il n'en dépend
    // pas, plutôt que de laisser croire qu'une valeur y jouerait un rôle.
    properties: {},
  };
}

/** Une vue de page, avec son URL, sa provenance et son chemin. */
function view(
  session: string,
  path: string,
  referrer?: string,
  url = `${SITE}${path}`,
): ActivityEvent {
  const attributes: Record<string, unknown> = {
    'page.path': path,
    'page.url': url,
  };
  if (referrer !== undefined) attributes['page.referrer'] = referrer;

  return event(session, VIEW_TYPE, attributes);
}

/**
 * Les provenances d'un journal, dans l'ordre où les sessions s'y montrent.
 *
 * Le journal passe par le vrai `sessionsOf` plutôt que par des `Session`
 * fabriquées à la main : un spec qui construirait ses propres sessions pourrait
 * éprouver une forme que la chaîne ne produit jamais.
 */
const sourcesOf = (events: readonly ActivityEvent[]): (Source | null)[] =>
  sessionsOf(events).map(sourceOf);

/** La provenance de l'unique session d'un journal. */
const sourceOfOnly = (events: readonly ActivityEvent[]): Source | null =>
  sourcesOf(events)[0];

/**
 * Une vue de page qui porte ce referrer, et rien d'autre à raconter.
 *
 * Chaque cas de classification passe donc par une session complète. C'est un peu
 * plus verbeux qu'un appel direct à la règle, et c'est le prix d'une seule porte
 * d'entrée : la règle brute n'est pas exportée, pour qu'aucun appelant ne puisse
 * contourner le refus de classer une session dont on n'a vu aucune page.
 */
const referrerLu = (referrer: string, pageUrl?: string): Source | null =>
  sourceOfOnly([view('s1', '/accueil', referrer, pageUrl)]);

describe('la nature d’un referrer', () => {
  it('classe une absence de referrer en direct', () => {
    expect(sourceOfOnly([view('s1', '/accueil')])).toEqual({
      kind: 'direct',
      name: null,
      label: 'Direct',
      // Une entrée directe n'a pas de site, donc pas d'icône. `null` dit
      // « pas de source à illustrer », pas « icône introuvable ».
      host: null,
    });
  });

  it('reconnaît un moteur de recherche par son label d’hôte', () => {
    expect(referrerLu('https://www.google.fr/search?q=x')).toEqual({
      kind: 'search',
      name: 'google',
      label: 'Google',
      host: 'google.com',
    });
    expect(referrerLu('https://news.google.com/x')).toEqual({
      kind: 'search',
      name: 'google',
      label: 'Google',
      host: 'google.com',
    });
  });

  it('reconnaît les autres moteurs de la liste', () => {
    for (const [hote, moteur, libelle, domaine] of [
      [
        'https://duckduckgo.com/?q=x',
        'duckduckgo',
        'DuckDuckGo',
        'duckduckgo.com',
      ],
      ['https://www.bing.com/search', 'bing', 'Bing', 'bing.com'],
      // `yandex.ru` classe sur `yandex`, et le domaine rendu est celui de la
      // marque — pas le ccTLD par lequel la session est arrivée. Le referrer a
      // déjà été réduit à un label ; on ne le reconstitue pas pour l'icône.
      ['https://yandex.ru/search', 'yandex', 'Yandex', 'yandex.com'],
      ['https://www.ecosia.org/search', 'ecosia', 'Ecosia', 'ecosia.org'],
    ]) {
      // La casse du libellé fait partie du contrat : `duckduckgo` ne se
      // capitalise pas comme `bing`, et c'est précisément ce qu'une table
      // côté client aurait fini par se tromper à écrire. Le domaine est là
      // pour la même raison — `ecosia.org` n'est pas devinable depuis
      // `ecosia`, et le client aurait fini par écrire `ecosia.com`.
      expect(referrerLu(hote)).toEqual({
        kind: 'search',
        name: moteur,
        label: libelle,
        host: domaine,
      });
    }
  });

  it('reconnaît un assistant, et ne le confond pas avec un moteur', () => {
    // La distinction n'est pas cosmétique : un moteur envoie vers une page, un
    // assistant a déjà répondu et n'envoie qu'accessoirement. Les fondre ferait
    // lire « la recherche m'apporte X visites » en y comptant autre chose.
    expect(referrerLu('https://chatgpt.com/c/abc')).toEqual({
      kind: 'assistant',
      name: 'chatgpt',
      label: 'ChatGPT',
      host: 'chatgpt.com',
    });
    expect(referrerLu('https://claude.ai/chat/x')).toEqual({
      kind: 'assistant',
      name: 'claude',
      label: 'Claude',
      host: 'claude.ai',
    });
    expect(referrerLu('https://www.perplexity.ai/search')).toEqual({
      kind: 'assistant',
      name: 'perplexity',
      label: 'Perplexity',
      host: 'perplexity.ai',
    });
  });

  it('fait gagner l’assistant sur le moteur quand l’hôte porte les deux', () => {
    // `gemini.google.com` porte les deux étiquettes. L'ordre inverse le
    // classerait « Google » et viderait la catégorie assistant là où elle est
    // la plus utile.
    expect(referrerLu('https://gemini.google.com/app')).toEqual({
      kind: 'assistant',
      name: 'gemini',
      label: 'Gemini',
      host: 'gemini.google.com',
    });
  });

  it('classe un site externe en referral, sans le www', () => {
    expect(referrerLu('https://www.blog.autre.test/a')).toEqual({
      kind: 'referral',
      name: 'blog.autre.test',
      // Un hôte s'écrit déjà comme il se lit : le libellé le reprend tel quel.
      label: 'blog.autre.test',
      host: 'blog.autre.test',
    });
  });

  it('classe notre propre origine en internal', () => {
    expect(referrerLu(`${SITE}/accueil`)).toEqual({
      kind: 'internal',
      name: 'shop.test',
      label: 'shop.test',
      host: 'shop.test',
    });
  });

  it('traite un sous-domaine comme externe', () => {
    // Décider que `docs.shop.test` est le même site demande une configuration
    // que rien ne porte aujourd'hui. Une ligne visible vaut mieux qu'un
    // rapprochement silencieux et faux.
    expect(referrerLu('https://docs.shop.test/a')).toEqual({
      kind: 'referral',
      name: 'docs.shop.test',
      label: 'docs.shop.test',
      host: 'docs.shop.test',
    });
  });

  it('classe en referral sans nom un referrer illisible', () => {
    expect(referrerLu('pas une url')).toEqual({
      kind: 'referral',
      name: null,
      // Pas de nom, donc le libellé retombe sur la nature. Inventer un nom
      // serait pire que de ne pas en donner ; ne rien écrire du tout
      // obligerait l'affichage à inventer son propre repli.
      label: 'Referral',
      // Le domaine, lui, ne retombe sur rien : `Referral` s'écrit, mais ne
      // s'illustre pas.
      host: null,
    });
  });

  it('ne devine pas notre origine quand l’URL de la page manque', () => {
    // Sans `page.url`, un rechargement ressemble à une recommandation. On
    // préfère une ligne `referral` qui se voit à un `internal` inventé.
    const sansUrl = sourceOfOnly([
      event('s1', VIEW_TYPE, {
        'page.path': '/accueil',
        'page.referrer': `${SITE}/tarifs`,
      }),
    ]);

    expect(sansUrl).toEqual({
      kind: 'referral',
      name: 'shop.test',
      label: 'shop.test',
      host: 'shop.test',
    });
  });
});

describe('une session, une provenance', () => {
  it('n’en rend qu’une pour une session de plusieurs pages', () => {
    // Le cas qui motive le niveau session : le referrer est figé au chargement
    // du document et voyage avec chaque événement. Compter les vues dirait trois
    // arrivées de Google pour une seule visite.
    const google = 'https://www.google.com/search?q=x';
    const sources = sourcesOf([
      view('s1', '/pricing', google),
      view('s1', '/checkout', google),
      event('s1', LEAVE_TYPE),
    ]);

    expect(sources).toEqual([
      { kind: 'search', name: 'google', label: 'Google', host: 'google.com' },
    ]);
  });

  it('prend l’entrée du premier page_view de la session', () => {
    const journal = [
      view('s1', '/accueil', 'https://www.google.com/search'),
      view('s1', '/tarifs', `${SITE}/accueil`),
    ];
    const [session] = sessionsOf(journal);

    expect(session.entry.path).toBe('/accueil');
    expect(sourceOf(session)).toEqual({
      kind: 'search',
      name: 'google',
      label: 'Google',
      host: 'google.com',
    });
  });

  it('ne laisse pas un page_view ultérieur écraser l’entrée', () => {
    // Le second referrer est interne : s'il gagnait, la session basculerait de
    // `search` à `internal` et l'acquisition disparaîtrait du rapport.
    const sources = sourcesOf([
      view('s1', '/accueil', 'https://duckduckgo.com/?q=x'),
      view('s1', '/tarifs', `${SITE}/accueil`),
      view('s1', '/panier', `${SITE}/tarifs`),
    ]);

    expect(sources).toEqual([
      {
        kind: 'search',
        name: 'duckduckgo',
        label: 'DuckDuckGo',
        host: 'duckduckgo.com',
      },
    ]);
  });

  it('ne laisse pas un page_leave ni un clic écraser l’entrée', () => {
    const sources = sourcesOf([
      view('s1', '/accueil', 'https://www.bing.com/search'),
      event('s1', LEAVE_TYPE, { 'page.referrer': 'https://autre.test/' }),
      event('s1', 'click', {
        'page.referrer': 'https://encore-autre.test/',
        'page.url': 'https://encore-autre.test/x',
      }),
    ]);

    expect(sources).toEqual([
      { kind: 'search', name: 'bing', label: 'Bing', host: 'bing.com' },
    ]);
  });

  it('n’ouvre pas de seconde entrée quand une présence se rouvre', () => {
    // La sortie ferme la présence, pas la session. Le `page_view` qui suit
    // rouvre une présence — il ne redéfinit pas d'où on vient.
    const sources = sourcesOf([
      view('s1', '/accueil', 'https://www.qwant.com/?q=x'),
      event('s1', LEAVE_TYPE),
      view('s1', '/tarifs', `${SITE}/accueil`),
    ]);

    expect(sources).toEqual([
      { kind: 'search', name: 'qwant', label: 'Qwant', host: 'qwant.com' },
    ]);
  });

  it('ignore navigation.from, y compris sur la vue d’entrée', () => {
    // `properties` n'est pas déclaré sur `ActivityEvent` : le sac où vit
    // `navigation.from` ne traverse même pas la frontière. Le poser dans les
    // attributs — le seul endroit d'où ce test peut le glisser — ne change donc
    // rien non plus.
    const avec = sourcesOf([
      view('s1', '/tarifs', 'https://www.google.com/search'),
    ]);
    const sans = sourcesOf([
      event('s1', VIEW_TYPE, {
        'page.path': '/tarifs',
        'page.url': `${SITE}/tarifs`,
        'page.referrer': 'https://www.google.com/search',
        'navigation.from': '/accueil',
      }),
    ]);

    expect(sans).toEqual(avec);
  });

  it('rend deux provenances pour deux sessions du même visiteur', () => {
    // Le défaut corrigé à l'étape 26. Avant, le premier `page_view` de la
    // fenêtre décidait pour toute la journée du visiteur, et la seconde
    // provenance était perdue.
    const sources = sourcesOf([
      view('matin', '/accueil', 'https://www.google.com/search?q=x'),
      event('matin', LEAVE_TYPE),
      view('soir', '/accueil'),
    ]);

    expect(sources).toEqual([
      { kind: 'search', name: 'google', label: 'Google', host: 'google.com' },
      { kind: 'direct', name: null, label: 'Direct', host: null },
    ]);
  });
});

describe('`null` n’est pas `direct`', () => {
  it('ne classe pas une session sans aucune vue de page', () => {
    const sources = sourcesOf([
      view('vue', '/accueil', 'https://www.google.com/search'),
      event('clics', 'click'),
      event('clics', 'form_submit'),
    ]);

    // Surtout pas `direct` : « aucune provenance connue » et « aucune page vue »
    // sont deux choses différentes, et les confondre gonflerait l'acquisition
    // d'un bruit qui n'a rien à voir avec elle.
    expect(sources).toEqual([
      { kind: 'search', name: 'google', label: 'Google', host: 'google.com' },
      null,
    ]);
  });

  it('laisse son entrée vide à une session sans vue de page', () => {
    const [session] = sessionsOf([event('s1', 'click')]);

    expect(session.entry).toEqual({});
    expect(session.pageViews).toBe(0);
  });

  it('classe quand même une vue de page dépouillée de tout attribut', () => {
    // `entry` est vide ici aussi, mais pour une autre raison : la page a bien
    // été vue. Elle vaut `direct`, et la ranger parmi les non-classables serait
    // perdre une session pour rien.
    expect(sourceOfOnly([event('s1', VIEW_TYPE)])).toEqual({
      kind: 'direct',
      name: null,
      label: 'Direct',
      host: null,
    });
  });

  it('ne rend rien sur un journal vide', () => {
    expect(sourcesOf([])).toEqual([]);
  });
});

describe('quand la fenêtre coupe le début de la session', () => {
  it('ne classe rien si aucune vue de page n’est visible', () => {
    // La fenêtre ne montre que la fin : des clics, puis la sortie. On ne
    // remonte pas chercher le vrai début, on dit qu'on ne sait pas. C'est au
    // lecteur de comparer `startedAt` à sa borne pour savoir pourquoi.
    expect(sourcesOf([event('s1', 'click'), event('s1', LEAVE_TYPE)])).toEqual([
      null,
    ]);
  });

  it('classe en internal une session multi-pages attrapée en cours de route', () => {
    // Chaque vue recharge le document, donc le referrer visible est notre
    // propre page précédente. `internal` est exactement la catégorie « on n'a
    // pas vu l'arrivée » — elle est hors acquisition, et sa part se lit.
    expect(sourceOfOnly([view('s1', '/tarifs', `${SITE}/accueil`)])).toEqual({
      kind: 'internal',
      name: 'shop.test',
      label: 'shop.test',
      host: 'shop.test',
    });
  });

  it('garde la bonne provenance d’une application monopage coupée', () => {
    // Le document n'a pas été rechargé : `document.referrer` porte encore la
    // vraie provenance externe. La classification est juste ; c'est `entry.path`
    // qui n'est pas une page d'atterrissage, et rien dans le journal seul ne
    // permet de le savoir — `startedAt < from` le dira au lecteur.
    const [session] = sessionsOf([
      view('s1', '/checkout', 'https://www.google.com/search'),
    ]);

    expect(sourceOf(session)).toEqual({
      kind: 'search',
      name: 'google',
      label: 'Google',
      host: 'google.com',
    });
    expect(session.entry.path).toBe('/checkout');
  });
});

describe('l’ordre des sessions', () => {
  it('est celui du journal, et n’est pas refait', () => {
    const journal = [view('b', '/x'), view('a', '/y'), view('c', '/z')];

    // Chronologique, pas alphabétique : `b` a émis en premier. Aucun tri n'est
    // appliqué nulle part — l'ordre vient de `sessionsOf`, qui le tient de
    // l'ordre total du Core.
    expect(sessionsOf(journal).map((s) => s.sessionId)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('conserve l’ordre de deux sessions ouvertes au même instant', () => {
    const instant = new Date('2026-08-22T10:00:00.000Z');
    const meme = (session: string): ActivityEvent => ({
      sessionId: session,
      sessionStartedAt: instant,
      visitorAlias: session,
      type: VIEW_TYPE,
      occurredAt: instant,
      attributes: { 'page.path': '/x', 'page.url': `${SITE}/x` },
      properties: {},
    });

    // Le départage a déjà eu lieu en amont : `events()` ordonne par
    // `occurred_at` puis `id`, donc le journal arrive ici déjà tranché. Le
    // refaire sur `sessionId` donnerait un autre ordre — arbitraire lui aussi,
    // mais qui contredirait celui du Core.
    expect(
      sessionsOf([meme('zeta'), meme('alpha')]).map((s) => s.sessionId),
    ).toEqual(['zeta', 'alpha']);
  });
});

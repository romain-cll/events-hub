import {
  LEAVE_TYPE,
  OUTBOUND_TYPE,
  sessionsOf,
  VIEW_TYPE,
  type ActivityEvent,
} from './sessions';

const MINUTE = 60 * 1000;

/** `'14:05'` → un `Date` du 20 août 2026. Le jour n'a aucune importance ici. */
function at(time: string): Date {
  return new Date(`2026-08-20T${time}:00.000Z`);
}

/**
 * Fabrique un événement. `session` est l'identifiant que le Core aurait
 * attribué à l'ingestion — ce module le lit, il ne le calcule pas.
 */
/**
 * Fabrique un événement.
 *
 * `sessionStartedAt` vaut l'instant de l'événement : ces tests décrivent des
 * sessions qu'on voit s'ouvrir. Le cas d'un début antérieur à la fenêtre est
 * celui de `session-metrics.spec.ts`, où il est le sujet.
 */
function event(
  session: string,
  type: string,
  time: string,
  attributes: Record<string, unknown> = {},
  debut = time,
  visiteur = session,
  properties: Record<string, unknown> = {},
): ActivityEvent {
  return {
    sessionId: session,
    sessionStartedAt: at(debut),
    // Un visiteur par session sauf mention contraire : le cas où deux sessions
    // en partagent un est le sujet d'un test précis, pas le décor des autres.
    visitorAlias: visiteur,
    type,
    occurredAt: at(time),
    attributes,
    properties,
  };
}

const view = (session: string, time: string, attrs?: Record<string, unknown>) =>
  event(session, VIEW_TYPE, time, attrs);
const leave = (session: string, time: string) =>
  event(session, LEAVE_TYPE, time);

describe('le repli du journal', () => {
  it('rend une session par identifiant, avec sa présence mesurée', () => {
    const sessions = sessionsOf([view('s1', '10:00'), leave('s1', '10:05')]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 's1',
      startedAt: at('10:00'),
      endedAt: at('10:05'),
      durationMs: 5 * MINUTE,
      activeMs: 5 * MINUTE,
      pageViews: 1,
      presencesStillOpen: 0,
    });
  });

  it('ne découpe pas : deux présences séparées restent une seule session', () => {
    // C'est le cœur de l'étape. Un aller-retour vers un autre onglet ferme la
    // présence, mais le Core a attribué le même `sessionId` aux quatre
    // événements — donc c'est une seule session, avec deux présences.
    const sessions = sessionsOf([
      view('s1', '10:00'),
      leave('s1', '10:04'),
      view('s1', '10:10'),
      leave('s1', '10:12'),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].presences).toEqual([
      { start: at('10:00'), end: at('10:04'), activeMs: 4 * MINUTE },
      { start: at('10:10'), end: at('10:12'), activeMs: 2 * MINUTE },
    ]);
    expect(sessions[0].activeMs).toBe(6 * MINUTE);
  });

  it("distingue l'étendue du temps mesuré", () => {
    // Douze minutes de session, six d'activité : les six autres sont le trou
    // entre les deux présences. Les confondre serait compter comme lu un onglet
    // resté en arrière-plan.
    const [session] = sessionsOf([
      view('s1', '10:00'),
      leave('s1', '10:04'),
      view('s1', '10:10'),
      leave('s1', '10:12'),
    ]);

    expect(session.durationMs).toBe(12 * MINUTE);
    expect(session.activeMs).toBe(6 * MINUTE);
    expect(session.activeMs).toBeLessThan(session.durationMs);
  });

  it('un page_view pendant une présence compte une page sans la rouvrir', () => {
    const [session] = sessionsOf([
      view('s1', '10:00'),
      view('s1', '10:03'),
      leave('s1', '10:07'),
    ]);

    expect(session.pageViews).toBe(2);
    // Une seule période, de la première vue à la sortie : naviguer, c'est
    // rester. La couper à 10:03 perdrait les trois premières minutes.
    expect(session.presences).toEqual([
      { start: at('10:00'), end: at('10:07'), activeMs: 7 * MINUTE },
    ]);
  });

  it('ignore un page_leave sans présence ouverte', () => {
    const [session] = sessionsOf([
      leave('s1', '10:00'),
      view('s1', '10:02'),
      leave('s1', '10:05'),
      leave('s1', '10:09'),
    ]);

    expect(session.presences).toEqual([
      { start: at('10:02'), end: at('10:05'), activeMs: 3 * MINUTE },
    ]);
    expect(session.activeMs).toBe(3 * MINUTE);
  });

  it('les autres types traversent la présence sans la délimiter', () => {
    const [session] = sessionsOf([
      view('s1', '10:00'),
      event('s1', 'click', '10:02'),
      event('s1', 'form_submit', '10:04'),
      leave('s1', '10:06'),
    ]);

    expect(session.presences).toHaveLength(1);
    expect(session.activeMs).toBe(6 * MINUTE);
    expect(session.pageViews).toBe(1);
  });

  it('les autres types reculent quand même la borne de fin', () => {
    // La présence s'arrête à 10:06 ; la session, elle, contient un clic à
    // 10:20. `endedAt` décrit le journal, pas l'activité.
    const [session] = sessionsOf([
      view('s1', '10:00'),
      leave('s1', '10:06'),
      event('s1', 'click', '10:20'),
    ]);

    expect(session.endedAt).toEqual(at('10:20'));
    expect(session.durationMs).toBe(20 * MINUTE);
    expect(session.activeMs).toBe(6 * MINUTE);
  });

  it('une présence jamais fermée ne produit aucune durée, et se compte', () => {
    const [session] = sessionsOf([view('s1', '10:00'), view('s1', '10:05')]);

    expect(session.presences).toEqual([]);
    expect(session.activeMs).toBe(0);
    expect(session.presencesStillOpen).toBe(1);
    // La session existe bel et bien, et son étendue est connue : c'est
    // seulement le temps *actif* qu'on ignore.
    expect(session.durationMs).toBe(5 * MINUTE);
  });

  it('ne compte pas comme ouverte une présence refermée plus tôt', () => {
    const [session] = sessionsOf([
      view('s1', '10:00'),
      leave('s1', '10:04'),
      event('s1', 'click', '10:06'),
    ]);

    expect(session.presencesStillOpen).toBe(0);
  });

  it("une session sans page_view sort vide plutôt qu'absente", () => {
    // La vue qui l'a ouverte est tombée hors fenêtre. On ne l'invente pas, mais
    // on ne perd pas les clics pour autant.
    const [session] = sessionsOf([
      event('s1', 'click', '10:00'),
      event('s1', 'click', '10:03'),
    ]);

    expect(session).toMatchObject({
      pageViews: 0,
      activeMs: 0,
      entry: {},
      presences: [],
      presencesStillOpen: 0,
      durationMs: 3 * MINUTE,
    });
  });

  it('sépare les sessions entrelacées sans les réordonner', () => {
    const sessions = sessionsOf([
      view('s1', '10:00'),
      view('s2', '10:01'),
      leave('s1', '10:03'),
      leave('s2', '10:09'),
    ]);

    // L'ordre est celui des ouvertures, pas celui des fermetures.
    expect(sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(sessions[0].activeMs).toBe(3 * MINUTE);
    expect(sessions[1].activeMs).toBe(8 * MINUTE);
  });

  it('rend une session de durée nulle pour un seul événement', () => {
    const [session] = sessionsOf([view('s1', '10:00')]);

    expect(session.startedAt).toEqual(at('10:00'));
    expect(session.endedAt).toEqual(at('10:00'));
    expect(session.durationMs).toBe(0);
  });

  it('rend une liste vide sur un journal vide', () => {
    expect(sessionsOf([])).toEqual([]);
  });
});

describe("l'entrée", () => {
  it('recopie le chemin, la provenance et l’URL du premier page_view', () => {
    const [session] = sessionsOf([
      view('s1', '10:00', {
        'page.path': '/accueil',
        'page.referrer': 'https://news.example/article',
        'page.url': 'https://shop.test/accueil',
      }),
    ]);

    expect(session.entry).toEqual({
      path: '/accueil',
      referrer: 'https://news.example/article',
      url: 'https://shop.test/accueil',
    });
  });

  it('recopie l’URL sans rien en déduire', () => {
    // Ce module transporte : il ne compare pas l'origine du referrer à la
    // nôtre, il donne juste de quoi le faire. La différence tient au fait que
    // `url` sort intacte, hôte compris, là où `path` l'a perdu.
    const [session] = sessionsOf([
      view('s1', '10:00', {
        'page.path': '/tarifs',
        'page.url': 'https://shop.test/tarifs?utm=x',
      }),
    ]);

    expect(session.entry.url).toBe('https://shop.test/tarifs?utm=x');
  });

  it("n'est pas remplacée par les page_view suivants", () => {
    const [session] = sessionsOf([
      view('s1', '10:00', { 'page.path': '/accueil' }),
      view('s1', '10:02', { 'page.path': '/tarifs' }),
    ]);

    expect(session.entry.path).toBe('/accueil');
  });

  it("n'est pas remplacée par le page_view qui rouvre une présence", () => {
    // Le cas qu'une simple garde « si entry est vide » raterait : la présence
    // s'est refermée, mais la session, elle, a toujours commencé sur /accueil.
    const [session] = sessionsOf([
      view('s1', '10:00', { 'page.path': '/accueil' }),
      leave('s1', '10:03'),
      view('s1', '10:08', { 'page.path': '/tarifs' }),
    ]);

    expect(session.entry.path).toBe('/accueil');
  });

  it('omet les clés absentes ou vides plutôt que de rendre du vide typé', () => {
    const [session] = sessionsOf([
      view('s1', '10:00', { 'page.path': '/accueil', 'page.referrer': '' }),
    ]);

    expect(session.entry).toEqual({ path: '/accueil' });
    expect('referrer' in session.entry).toBe(false);
  });

  it('ignore une valeur qui n’est pas une chaîne', () => {
    const [session] = sessionsOf([view('s1', '10:00', { 'page.path': 42 })]);

    expect(session.entry).toEqual({});
  });

  it('une entrée légitimement vide ne laisse pas la vue suivante prendre sa place', () => {
    const [session] = sessionsOf([
      view('s1', '10:00'),
      view('s1', '10:02', { 'page.path': '/tarifs' }),
    ]);

    expect(session.entry).toEqual({});
  });
});

/**
 * L'alias traverse le repli sans être interprété.
 *
 * Ce module ne compte pas de visiteurs et n'en comparera jamais deux : il
 * transporte, et c'est le lecteur qui dédoublonne. Ce qu'on vérifie ici est
 * donc étroit — la valeur arrive intacte sur la ligne, y compris quand deux
 * sessions la partagent, ce qui est précisément le cas que le repli pourrait
 * effacer sans qu'on le voie.
 */
describe("l'alias de visiteur", () => {
  it('est recopié depuis les événements sur la session', () => {
    const [session] = sessionsOf([
      event('s1', VIEW_TYPE, '10:00', {}, '10:00', 'v1'),
    ]);

    expect(session.visitorAlias).toBe('v1');
  });

  it('est partagé par deux sessions du même visiteur', () => {
    // Le cas qui justifie le champ. Sans lui, ces deux lignes seraient deux
    // visiteurs pour un lecteur qui compte — alors que c'est la même personne
    // revenue après plus de trente minutes, donc la même clé du jour.
    const sessions = sessionsOf([
      event('matin', VIEW_TYPE, '09:00', {}, '09:00', 'v1'),
      event('soir', VIEW_TYPE, '21:00', {}, '21:00', 'v1'),
    ]);

    expect(sessions.map((session) => session.visitorAlias)).toEqual([
      'v1',
      'v1',
    ]);
  });

  it('sépare deux visiteurs présents dans le même journal', () => {
    const sessions = sessionsOf([
      event('s1', VIEW_TYPE, '10:00', {}, '10:00', 'v1'),
      event('s2', VIEW_TYPE, '10:01', {}, '10:01', 'v2'),
    ]);

    expect(new Set(sessions.map((session) => session.visitorAlias)).size).toBe(
      2,
    );
  });

  describe('la sortie', () => {
    const LIEN = { 'link.origin': 'https://checkout.stripe.com' };

    const sortie = (...journal: ActivityEvent[]) => sessionsOf(journal)[0].exit;

    it('retient la dernière vue, pas la première', () => {
      // Le miroir exact d'`entry`, qui garde la première et n'en démord pas.
      expect(
        sortie(
          event('s', VIEW_TYPE, '10:00', { 'page.path': '/' }),
          event('s', VIEW_TYPE, '10:05', { 'page.path': '/panier' }),
        ).path,
      ).toBe('/panier');
    });

    it('retient le dernier clic sortant, pas le premier', () => {
      // Un visiteur peut revenir : ouvrir un onglet vers GitHub, relire deux
      // pages, puis partir vers Stripe. La sortie, c'est Stripe.
      expect(
        sortie(
          event('s', VIEW_TYPE, '10:00', { 'page.path': '/' }),
          event('s', OUTBOUND_TYPE, '10:01', {}, '10:00', 's', {
            'link.origin': 'https://github.com',
          }),
          event('s', VIEW_TYPE, '10:20', { 'page.path': '/panier' }),
          event('s', OUTBOUND_TYPE, '10:21', {}, '10:00', 's', LIEN),
        ).outbound,
      ).toBe('https://checkout.stripe.com');
    });

    it('rend les deux : d’où on est parti, et vers où', () => {
      expect(
        sortie(
          event('s', VIEW_TYPE, '10:00', { 'page.path': '/panier' }),
          event('s', OUTBOUND_TYPE, '10:01', {}, '10:00', 's', LIEN),
        ),
      ).toEqual({
        path: '/panier',
        outbound: 'https://checkout.stripe.com',
      });
    });

    it('laisse `outbound` nul quand la session s’éteint sur place', () => {
      // Ce qui ne veut **pas** dire que le visiteur est resté : fermer
      // l'onglet et taper une autre adresse se ressemblent depuis ici.
      expect(
        sortie(
          event('s', VIEW_TYPE, '10:00', { 'page.path': '/' }),
          event('s', LEAVE_TYPE, '10:02'),
        ).outbound,
      ).toBeNull();
    });

    it('n’efface pas une sortie connue avec un clic illisible', () => {
      // Une origine manquante n'est pas une nouvelle destination : elle ne
      // doit pas remplacer celle qu'on tenait.
      expect(
        sortie(
          event('s', VIEW_TYPE, '10:00', { 'page.path': '/' }),
          event('s', OUTBOUND_TYPE, '10:01', {}, '10:00', 's', LIEN),
          event('s', OUTBOUND_TYPE, '10:02'),
        ).outbound,
      ).toBe('https://checkout.stripe.com');
    });

    it('ne compte pas un clic sortant comme une vue de page', () => {
      const [session] = sessionsOf([
        event('s', VIEW_TYPE, '10:00', { 'page.path': '/' }),
        event('s', OUTBOUND_TYPE, '10:01', {}, '10:00', 's', LIEN),
      ]);

      // Il déplace la sortie, il ne touche à rien d'autre — ni au compteur de
      // pages, ni aux présences.
      expect(session.pageViews).toBe(1);
      expect(session.presences).toHaveLength(0);
    });

    it('laisse `path` nul sur une session sans aucune vue', () => {
      expect(sortie(event('s', 'click', '10:00')).path).toBeNull();
    });
  });
});

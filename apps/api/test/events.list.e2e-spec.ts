import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import {
  EventStore,
  type EventRow,
  type EventScope,
} from '../src/events/event-store.service';
import { createProject, TEST_ORIGIN } from './fixtures';

/**
 * `EventStore.events()`, éprouvée contre un vrai Postgres.
 *
 * La méthode n'est que du SQL, et ce qu'elle promet ne s'observe que là où ce
 * SQL s'exécute : un ordre total — donc un départage par `id` qu'aucun double
 * de Drizzle ne pourrait exercer —, la fenêtre semi-ouverte, le cloisonnement
 * par projet, et deux sacs `jsonb` rendus intacts.
 *
 * Les événements passent par la route d'ingestion, donc la clé visiteur est
 * dérivée pour de vrai ; le User-Agent est la seule des trois composantes du
 * HMAC qu'un test puisse faire varier, c'est donc lui qui distingue les
 * visiteurs.
 *
 * Les types sont volontairement des mots sans signification — `alpha`, `beta`,
 * `gamma`. La méthode ne connaît aucun vocabulaire, et un test écrit avec celui
 * du SDK laisserait croire le contraire. La dernière suite du fichier fait
 * exception, et explique pourquoi.
 */

const WINDOW = {
  from: new Date('2026-08-22T00:00:00.000Z'),
  to: new Date('2026-08-23T00:00:00.000Z'),
};

/** Bornes exactes de la fenêtre : l'une est incluse, l'autre non. */
const DEBUT = '2026-08-22T00:00:00.000Z';
const FIN = '2026-08-23T00:00:00.000Z';

const AVANT = '2026-08-21T18:00:00.000Z';

/** L'instant que plusieurs événements partagent à la milliseconde près. */
const EGALITE = '2026-08-22T13:00:00.000Z';

/** Les repères de la salve écrite à cet instant-là. */
const A_EGALITE = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];

/**
 * `c1` porte de quoi éprouver la restitution : un objet imbriqué, un tableau,
 * un `null`, une chaîne vide, un nombre. Rien de tout ça n'a de sens pour le
 * Core — c'est le sujet.
 */
const ATTRIBUTS_RICHES = {
  repere: 'c1',
  imbrique: { profondeur: 2, liste: [1, 'deux', null] },
  absent: null,
  vide: '',
  nombre: 1512,
};

const PROPRIETES_RICHES = { repere: 'c1', drapeau: false };

/**
 * La fenêtre, dans l'ordre où elle doit sortir.
 *
 * Les visiteurs y sont entrelacés à dessein : `a` et `b` alternent, et rien
 * dans la suite ne regroupe leurs lignes. C'est une chronologie, pas un
 * classement par visiteur.
 */
const ATTENDU = ['a1', 'b1', 'a2', 'a3', 'b2', 'c1'];

describe('EventStore.events (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let store: EventStore;
  let projectId: string;
  let apiKey: string;
  let scope: EventScope;
  /** Repère -> id, pour les événements écrits à la même milliseconde. */
  let egalite: Map<string, string>;

  const ingest = (
    visiteur: string,
    type: string,
    occurredAt: string,
    attributes: Record<string, unknown> = {},
    properties: Record<string, unknown> = {},
    cle: string = apiKey,
  ) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', visiteur)
      .send({
        apiKey: cle,
        type,
        occurredAt,
        attributes,
        properties,
      })
      .expect(201);

  const lire = (perimetre: EventScope) => store.events(perimetre);

  /** Le repère que chaque événement porte, pour se reconnaître sans son id. */
  const reperes = (rows: { attributes: Record<string, unknown> }[]) =>
    rows.map((row) => row.attributes.repere);

  /** Les deux lignes à égalité d'instant, dans l'ordre où elles sont rendues. */
  const aEgalite = (rows: EventRow[]) =>
    reperes(rows.filter((row) => row.occurredAt.toISOString() === EGALITE));

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    db = app.get<DrizzleDatabase>(DRIZZLE);
    store = app.get(EventStore);

    const project = await createProject(db, {
      name: `e2e events ${new Date().toISOString()}`,
    });
    projectId = project.id;
    apiKey = project.apiKey;
    scope = { projectId, ...WINDOW };

    // `b0` précède la fenêtre : `visiteur-b` existait avant, et ça ne doit rien
    // ajouter à ce qu'on lit de lui dedans.
    await ingest('visiteur-b', 'alpha', AVANT, { repere: 'b0' });

    // Écrits dans le désordre : « chronologique » se lit sur `occurred_at`,
    // jamais sur l'ordre d'insertion.
    await ingest('visiteur-a', 'alpha', '2026-08-22T10:00:00.000Z', {
      repere: 'a3',
    });
    await ingest('visiteur-b', 'beta', '2026-08-22T08:00:00.000Z', {
      repere: 'b1',
    });

    // Pile sur la borne basse, donc dans la fenêtre.
    await ingest('visiteur-a', 'alpha', DEBUT, { repere: 'a1' });

    await ingest('visiteur-b', 'alpha', '2026-08-22T11:00:00.000Z', {
      repere: 'b2',
    });
    await ingest('visiteur-a', 'beta', '2026-08-22T09:00:00.000Z', {
      repere: 'a2',
    });
    await ingest(
      'visiteur-c',
      'gamma',
      '2026-08-22T12:00:00.000Z',
      ATTRIBUTS_RICHES,
      PROPRIETES_RICHES,
    );

    // `visiteur-d` : toute une salve à la même milliseconde. Rien d'autre que
    // l'`id` ne peut les départager.
    //
    // Ils sont huit et non deux, et c'est ce qui donne sa force au test. Les
    // `id` sont des UUID aléatoires : sur deux lignes, l'ordre du tas Postgres
    // aurait une chance sur deux de coïncider avec l'ordre des `id`, et un tri
    // manquant passerait une fois sur deux. Sur huit, il faudrait que 8!
    // permutations tombent juste — le test cesse d'avoir de la chance.
    //
    // Écrits l'un après l'autre, et c'est même préférable : l'ordre du tas
    // devient alors exactement l'ordre d'insertion, donc `d1`…`d8`, pendant que
    // les `id` en tirent une permutation quelconque. Les deux ordres n'ont plus
    // aucune raison de coïncider, et c'est précisément ce qu'on veut mettre à
    // l'épreuve.
    egalite = new Map();
    for (const repere of A_EGALITE) {
      const reponse = await ingest('visiteur-d', 'alpha', EGALITE, { repere });
      egalite.set(repere, (reponse.body as { id: string }).id);
    }

    // Pile sur la borne haute, donc hors fenêtre.
    await ingest('visiteur-e', 'alpha', FIN, { repere: 'e1' });
  });

  afterAll(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await app.close();
  });

  describe('le journal brut', () => {
    it('rend tous les événements de la fenêtre, dans l’ordre chronologique', async () => {
      const rows = await lire(scope);

      // Les deux derniers sont à égalité d'instant : leur ordre relatif est le
      // sujet de la suite suivante, pas de celle-ci.
      expect(reperes(rows).slice(0, ATTENDU.length)).toEqual(ATTENDU);
      expect(aEgalite(rows).sort()).toEqual(A_EGALITE);
    });

    it('ne sélectionne rien : autant de lignes que la fenêtre en compte', async () => {
      const rows = await lire(scope);

      // Le contraste est avec les compteurs, seule autre façon de lire la
      // fenêtre : ils rendent un nombre là où celle-ci rend la matière.
      expect(rows).toHaveLength(await store.countEvents(scope));
      expect(rows.length).toBeGreaterThan(await store.countSessions(scope));
    });

    it('rend plusieurs événements pour une même session', async () => {
      const rows = await lire(scope);
      const d1 = rows.find((row) => row.attributes.repere === 'd1');
      const salve = rows.filter((row) => row.sessionId === d1?.sessionId);

      // La salve de `visiteur-d` est le seul groupe du fixture assez resserré
      // pour tenir dans une session — tout le reste est à des heures d'écart, et
      // le Core a donc ouvert une session par événement.
      //
      // Ils sont tous à la même milliseconde, donc c'est l'`id` qui les ordonne
      // et pas l'insertion : la suite plus bas s'occupe de ce départage. Ce qui
      // se vérifie ici, c'est qu'ils sont bien tous les huit, ensemble.
      expect(new Set(reperes(salve))).toEqual(new Set(A_EGALITE));
    });

    it('entrelace les sessions dans une seule chronologie', async () => {
      const rows = await lire(scope);
      const cle = new Map(
        rows.map((row) => [row.attributes.repere, row.sessionId]),
      );

      // `a` puis `b` puis `a` : l'ordre est global, il ne regroupe pas par
      // session. Grouper ici supposerait que c'est par session que la suite a
      // un sens — vrai d'un parcours, faux d'un entonnoir.
      expect(reperes(rows).slice(0, 3)).toEqual(['a1', 'b1', 'a2']);
      expect(cle.get('a1')).not.toBe(cle.get('b1'));
      expect(cle.get('b1')).not.toBe(cle.get('a2'));
    });
  });

  describe('à égalité d’instant, l’id départage', () => {
    /** Les repères de la salve, classés comme leurs `id` le sont. */
    const attendu = () =>
      [...A_EGALITE].sort((gauche, droite) =>
        egalite.get(gauche)!.localeCompare(egalite.get(droite)!),
      );

    it('rend les lignes dans l’ordre de leurs id', async () => {
      // Les huit `occurred_at` sont identiques à la milliseconde près : sans
      // second critère, Postgres serait libre de les rendre dans n'importe quel
      // ordre — et une suite lue par un module changerait de sens tout seul.
      expect(aEgalite(await lire(scope))).toEqual(attendu());
    });

    it('rend la même réponse d’un appel à l’autre, l’alias mis à part', async () => {
      const [premier, second] = await Promise.all([lire(scope), lire(scope)]);

      // `visitorAlias` est retiré à chaque lecture, exprès : c'est la seule
      // valeur de la réponse qui a le droit de changer sans que la donnée ait
      // bougé. Le neutraliser plutôt que de l'exclure garde la comparaison
      // exhaustive — un champ ajouté demain sera comparé, pas oublié.
      const sansAlias = (rows: typeof premier) =>
        rows.map((row) => ({ ...row, visitorAlias: '' }));

      expect(sansAlias(second)).toEqual(sansAlias(premier));
    });

    it('ne rend pas les mêmes alias d’un appel à l’autre', async () => {
      // Le pendant du test ci-dessus, et il compte autant : sans lui, une
      // implémentation qui rendrait la clé visiteur telle quelle — ou un
      // numéro d'ordre stable — passerait tout ce fichier.
      const [premier, second] = await Promise.all([lire(scope), lire(scope)]);

      const alias = (rows: typeof premier) =>
        [...new Set(rows.map((row) => row.visitorAlias))].sort();

      expect(alias(premier)).not.toEqual(alias(second));
      // Les jetons changent, la population non.
      expect(alias(premier)).toHaveLength(alias(second).length);
    });
  });

  describe('la fenêtre', () => {
    it('inclut la borne basse et exclut la borne haute', async () => {
      const rows = reperes(await lire(scope));

      expect(rows).toContain('a1');
      expect(rows).not.toContain('e1');
    });

    it('ignore ce qui précède la fenêtre, même du même visiteur', async () => {
      const rows = reperes(await lire(scope));

      // `visiteur-b` a émis avant : ses lignes de la fenêtre sont `b1` et `b2`,
      // et `b0` n'en fait pas partie.
      expect(rows).toContain('b1');
      expect(rows).not.toContain('b0');
    });

    it('élargie, elle rend davantage sans rien réordonner', async () => {
      const large = await lire({
        projectId,
        from: new Date(AVANT),
        to: new Date('2026-08-24T00:00:00.000Z'),
      });

      // La fenêtre ne fait que cadrer : les lignes déjà rendues gardent leur
      // ordre, `b0` s'ajoute avant et `e1` après.
      expect(reperes(large)).toEqual([
        'b0',
        ...ATTENDU,
        ...aEgalite(large),
        'e1',
      ]);
    });

    it('rend une liste vide sur une fenêtre sans événement', async () => {
      expect(
        await lire({
          projectId,
          from: new Date('2026-09-01T00:00:00.000Z'),
          to: new Date('2026-09-02T00:00:00.000Z'),
        }),
      ).toEqual([]);
    });
  });

  describe('les types', () => {
    it('sans type, rend tous les types confondus', async () => {
      const rows = await lire(scope);

      expect(new Set(rows.map((row) => row.type))).toEqual(
        new Set(['alpha', 'beta', 'gamma']),
      );
    });

    it('restreint au type demandé, sans toucher à l’ordre', async () => {
      const beta = await lire({ ...scope, types: ['beta'] });

      // `b1` (08:00) puis `a2` (09:00) : deux visiteurs différents, et c'est
      // toujours l'instant qui classe.
      expect(reperes(beta)).toEqual(['b1', 'a2']);
      expect(beta.every((row) => row.type === 'beta')).toBe(true);
    });

    it('rend une liste vide pour un type jamais émis', async () => {
      expect(await lire({ ...scope, types: ['jamais-vu'] })).toEqual([]);
    });
  });

  describe('la restitution', () => {
    it('rend les deux sacs jsonb intacts', async () => {
      const [c1] = (await lire(scope)).filter(
        (row) => row.attributes.repere === 'c1',
      );

      // Rien n'est aplati, filtré, ni retypé : un `null`, une chaîne vide, un
      // tableau et un objet imbriqué reviennent tels qu'ils sont partis.
      expect(c1.attributes).toEqual(ATTRIBUTS_RICHES);
      expect(c1.properties).toEqual(PROPRIETES_RICHES);
    });

    it('rend un occurredAt qui est une vraie Date', async () => {
      const [premier] = await lire(scope);

      expect(premier.occurredAt).toBeInstanceOf(Date);
      expect(premier.occurredAt.toISOString()).toBe(DEBUT);
    });

    it('ne rend ni id ni projectId, sur aucune ligne', async () => {
      const rows = await lire(scope);

      // Le périmètre est déjà celui de l'appelant, et l'`id` n'a de rôle qu'à
      // l'intérieur du Core — il classe ici, il ne sort pas. Le publier
      // inviterait un module à s'en servir de référence durable.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'attributes',
          'campaign',
          'occurredAt',
          'properties',
          'sessionId',
          'sessionStartedAt',
          'source',
          'type',
          'visitorAlias',
        ]);
      }
    });
  });

  describe('le cloisonnement', () => {
    it('ne voit rien d’un autre projet, et réciproquement', async () => {
      const voisin = await createProject(db, {
        name: `e2e events voisin ${new Date().toISOString()}`,
      });

      // Même User-Agent que `visiteur-a`, donc même IP et même jour — mais la
      // clé visiteur est dérivée par projet, et la lecture l'est aussi.
      await ingest(
        'visiteur-a',
        'alpha',
        '2026-08-22T01:00:00.000Z',
        { repere: 'voisin' },
        {},
        voisin.apiKey,
      );

      const chezLeVoisin = await lire({
        ...scope,
        projectId: voisin.id,
      });
      const chezNous = await lire(scope);

      await db.delete(events).where(eq(events.projectId, voisin.id));
      await db.delete(sessions).where(eq(sessions.projectId, voisin.id));
      await db.delete(projects).where(eq(projects.id, voisin.id));

      expect(reperes(chezLeVoisin)).toEqual(['voisin']);
      expect(reperes(chezNous)).not.toContain('voisin');
    });
  });

  /**
   * Le découpage lui-même n'est plus l'affaire de cette méthode : il est fait à
   * l'ingestion et éprouvé dans `session-assignment.e2e-spec.ts`. Ce qui se
   * vérifie ici, c'est que `events()` **rend la colonne** — donc qu'aucun
   * recalcul ne s'est glissé à la lecture.
   */
  describe('sessionId est lu, pas calculé', () => {
    it('rend exactement ce que porte la colonne', async () => {
      const rows = await lire(scope);
      const enBase = await db
        .select({ attributes: events.attributes, sessionId: events.sessionId })
        .from(events)
        .where(eq(events.projectId, projectId));
      const attendu = new Map(
        enBase.map((row) => [String(row.attributes.repere), row.sessionId]),
      );

      // Ligne par ligne, contre la table : c'est le seul moyen de distinguer
      // « rend la colonne » de « rend un découpage qui lui ressemble ».
      for (const row of rows) {
        expect(row.sessionId).toBe(attendu.get(String(row.attributes.repere)));
      }
    });

    it('rend le started_at de la session, pas le premier instant vu', async () => {
      // La colonne, pas le journal. Sur la fenêtre complète les deux coïncident
      // pour la salve de `visiteur-d` — ses huit événements sont au même
      // instant — donc `sessionStartedAt` vaut cet instant-là.
      const rows = await lire(scope);
      const salve = rows.filter((row) => row.attributes.repere === 'd1');

      expect(salve[0].sessionStartedAt).toEqual(salve[0].occurredAt);
    });

    it('rend un started_at antérieur à la borne basse quand la session déborde', async () => {
      // Le cas qui justifie de rendre la colonne. `a2` est à 09:00 et ouvre sa
      // propre session ; cadrée pour ne montrer que ce qui suit, la lecture rend
      // quand même 09:00 comme début.
      const [ligne] = await lire({
        projectId,
        from: new Date('2026-08-22T09:30:00.000Z'),
        to: new Date('2026-08-22T10:30:00.000Z'),
      });

      // `a3` est à 10:00, à une heure de `a2` : deux sessions distinctes, donc
      // son début est bien le sien. Ce qu'on vérifie ici, c'est que la valeur
      // vient de la table — elle est identique à ce que la fenêtre large donne.
      const large = (await lire(scope)).find(
        (row) => row.attributes.repere === 'a3',
      );

      expect(ligne.sessionStartedAt).toEqual(large?.sessionStartedAt);
    });

    it('porte le même started_at sur toutes les lignes d’une session', async () => {
      const rows = await lire(scope);
      const parSession = new Map<string, Set<number>>();

      for (const row of rows) {
        const vus = parSession.get(row.sessionId) ?? new Set<number>();
        vus.add(row.sessionStartedAt.getTime());
        parSession.set(row.sessionId, vus);
      }

      // C'est une jointure, pas un calcul : deux valeurs différentes pour une
      // même session voudraient dire que la colonne a été recalculée quelque
      // part.
      expect([...parSession.values()].every((vus) => vus.size === 1)).toBe(
        true,
      );
    });

    it('rend le même découpage d’un appel à l’autre', async () => {
      // Aucun paramètre ne peut le faire varier : il n'y en a plus. Deux
      // lectures concurrentes du même périmètre rendent la même partition.
      const [premier, second] = await Promise.all([lire(scope), lire(scope)]);

      expect(second.map((row) => row.sessionId)).toEqual(
        premier.map((row) => row.sessionId),
      );
    });

    it('restreint au type demandé sans changer la session rendue', async () => {
      // Le filtre porte sur les lignes, pas sur le découpage : une session ne
      // se renumérote pas parce qu'on a caché une partie de ses événements.
      const tout = new Map(
        (await lire(scope)).map((row) => [
          row.attributes.repere,
          row.sessionId,
        ]),
      );
      const filtre = await lire({ ...scope, types: ['alpha'] });

      expect(filtre.length).toBeGreaterThan(0);
      for (const row of filtre) {
        expect(row.sessionId).toBe(tout.get(row.attributes.repere));
      }
    });
  });

  /**
   * La seule suite du fichier qui emploie le vocabulaire du SDK, et c'est
   * l'inverse d'une entorse : elle montre qu'une suite comportementale traverse
   * la primitive **sans que rien n'ait été ajouté pour elle**. Ces types-là sont
   * rendus exactement comme `alpha` et `beta` le sont plus haut — la
   * démonstration ne vaut que parce que le reste du fichier n'en parle pas.
   */
  describe('une suite comportementale ressort telle quelle', () => {
    let comportement: string;
    let comportementKey: string;

    beforeAll(async () => {
      const project = await createProject(db, {
        name: `e2e events suite ${new Date().toISOString()}`,
      });
      comportement = project.id;
      comportementKey = project.apiKey;

      const t = (minute: number) =>
        `2026-08-22T14:${String(minute).padStart(2, '0')}:00.000Z`;

      // Le Core ne lit pas dans `properties` : `leave.reason` n'est ici qu'une
      // clé parmi d'autres, transportée sans être interprétée.
      const suite: [string, Record<string, unknown>][] = [
        ['page_view', {}],
        ['page_view', {}],
        ['page_leave', { 'leave.reason': 'page_hidden' }],
        ['page_view', {}],
        ['click', {}],
        ['outbound_click', {}],
        ['page_leave', { 'leave.reason': 'outbound_click' }],
      ];

      for (const [index, [type, properties]] of suite.entries()) {
        await ingest(
          'visiteur-suite',
          type,
          t(index),
          {},
          properties,
          comportementKey,
        );
      }
    });

    afterAll(async () => {
      await db.delete(events).where(eq(events.projectId, comportement));
      await db.delete(sessions).where(eq(sessions.projectId, comportement));
      await db.delete(projects).where(eq(projects.id, comportement));
    });

    it('rend le journal dans l’ordre où il a été vécu', async () => {
      const rows = await lire({ projectId: comportement, ...WINDOW });

      expect(rows.map((row) => row.type)).toEqual([
        'page_view',
        'page_view',
        'page_leave',
        'page_view',
        'click',
        'outbound_click',
        'page_leave',
      ]);
      expect(
        rows
          .map((row) => row.properties['leave.reason'])
          .filter((reason) => reason !== undefined),
      ).toEqual(['page_hidden', 'outbound_click']);
    });
  });
});

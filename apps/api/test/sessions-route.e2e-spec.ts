import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { sessionsPageSchema } from '@events-hub/api-contract';

import {
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  TEST_ORIGIN,
} from './fixtures';

/**
 * `GET /v1/projects/:projectId/analytics/sessions`, éprouvée par sa route.
 *
 * `sessions.spec.ts` fixe le *repli* sur des journaux écrits à la main,
 * `entry-source.spec.ts` fixe la *classification* ; ce fichier vérifie le
 * **contrat d'API** : quels champs sortent, avec quelles valeurs, et lesquels ne
 * sortent pas.
 *
 * Ce que les tests unitaires ne pouvaient pas voir : la sérialisation JSON, la
 * validation de la query, le 404, le cloisonnement — et l'accord avec `GET
 * /analytics`, qui compte les mêmes sessions par un tout autre chemin.
 *
 * ## Ce que la route rend depuis l'étape 33
 *
 * Des **lignes**, plus des totaux. Elle en rendait six, et une route voisine
 * rendait la répartition par provenance des mêmes sessions : deux lectures du
 * même journal dont deux compteurs étaient numériquement identiques. Tous ces
 * totaux se refont chez le lecteur, et plusieurs tests d'ici les refont
 * exactement comme lui les refera — c'est le bon niveau de fidélité.
 *
 * Les événements passent par la route d'ingestion, donc les sessions sont
 * découpées par le vrai `SessionAssigner`. Le User-Agent distingue les
 * visiteurs.
 */

const JOUR = '2026-08-22';
const at = (heure: string) => `${JOUR}T${heure}:00.000Z`;

const MINUTE = 60_000;
const SITE = 'https://shop.test';
const GOOGLE = 'https://www.google.com/search?q=x';

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

interface SourceJson {
  kind: string;
  name: string | null;
  label: string;
}

interface SessionRowJson {
  visitorAlias: string;
  startedAt: string;
  endedAt: string;
  activeMs: number;
  pageViews: number;
  presencesStillOpen: number;
  entryPath: string | null;
  exit: { path: string | null; outbound: string | null };
  settled: boolean;
  source: SourceJson | null;
}

interface SessionsPageJson {
  from: string;
  to: string;
  sessions: SessionRowJson[];
}

describe('GET /v1/projects/:projectId/analytics/sessions (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projectId: string;
  let apiKey: string;
  /** Le compte qui lit : membre de l'organisation des projets de test. */
  let cookies: string[];
  const created: string[] = [];

  const newProject = async (label: string) => {
    const project = await createProject(db, {
      name: `e2e sessions route ${label} ${new Date().toISOString()}`,
    });

    created.push(project.id);
    return project;
  };

  const ingest = (
    visiteur: string,
    type: string,
    heure: string,
    attributes: Record<string, unknown> = {},
    cle: string = apiKey,
    properties?: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', visiteur)
      .send({
        apiKey: cle,
        type,
        occurredAt: heure.includes('T') ? heure : at(heure),
        attributes: { 'page.path': '/', ...attributes },
        properties:
          properties ??
          (type === 'page_leave' ? { 'leave.reason': 'page_hidden' } : {}),
      })
      .expect(201);

  /** Une vue de page avec son chemin, son URL et sa provenance. */
  const vue = (
    visiteur: string,
    heure: string,
    path: string,
    referrer?: string,
  ) =>
    ingest(visiteur, 'page_view', heure, {
      'page.path': path,
      'page.url': `${SITE}${path}`,
      ...(referrer === undefined ? {} : { 'page.referrer': referrer }),
    });

  const lire = async (
    query: Record<string, string> = FENETRE,
    project: string = projectId,
  ) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/analytics/sessions`)
      .set('Cookie', cookies)
      .query(query)
      .expect(200);

    expectMatchesContract(response.body, sessionsPageSchema);

    return response.body as SessionsPageJson;
  };

  /**
   * Les compteurs que le lecteur refait depuis les lignes.
   *
   * Ce sont exactement les prédicats que `SessionRow` documente, écrits ici tels
   * que le dashboard les écrira. Les recopier plutôt que de les importer est
   * volontaire : s'ils vivaient dans le module, la route rendrait à nouveau des
   * conclusions.
   */
  const compter = ({ from, sessions: lot }: SessionsPageJson) => {
    const borne = new Date(from).getTime();
    const sansSource = lot.filter((row) => row.source === null);

    return {
      sessions: lot.length,
      attribuees: lot.length - sansSource.length,
      tronquees: sansSource.filter(
        (row) => new Date(row.startedAt).getTime() < borne,
      ).length,
      sansVue: sansSource.filter(
        (row) => new Date(row.startedAt).getTime() >= borne,
      ).length,
      pageViews: lot.reduce((somme, row) => somme + row.pageViews, 0),
      activeMs: lot.reduce((somme, row) => somme + row.activeMs, 0),
    };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    db = app.get<DrizzleDatabase>(DRIZZLE);

    // Les analytics ne sont plus publiques : il faut un compte, et il faut
    // qu'il soit membre de l'organisation qui porte les projets de test.
    const reader = await signUp(app);
    cookies = reader.cookies;
    await joinOrganization(db, await organizationId(db), reader.id);
    const principal = await newProject('principal');
    projectId = principal.id;
    apiKey = principal.apiKey;

    // `alice`  09:00 vue // referrer google, 09:04 sortie → présence de 4 min
    //          09:20 vue /tarifs, referrer interne         → présence de 6 min
    //          09:26 sortie                                  même session
    //          → 1 session, 2 pages, 10 min actives, source search/google
    await vue('alice', '09:00', '/', GOOGLE);
    await ingest('alice', 'page_leave', '09:04');
    await vue('alice', '09:20', '/tarifs', `${SITE}/`);
    await ingest('alice', 'page_leave', '09:26');

    // `bob`    09:10 vue sans referrer, jamais fermée → présence ouverte
    //          09:22 clic, même session (12 min d'écart)
    //          → 1 session, 1 page, 0 ms actives, source direct
    //
    // Le clic est là pour qu'une fenêtre partant de 09:15 voie bob **sans**
    // aucune de ses vues : c'est le seul moyen d'obtenir une session à la fois
    // tronquée et non classée, l'un des trois états que le lecteur doit
    // distinguer.
    await vue('bob', '09:10', '/prix');
    await ingest('bob', 'click', '09:22');

    // `carol`  un clic, rien d'autre
    //          → 1 session, 0 page, source null
    await ingest('carol', 'click', '09:15');
  });

  afterAll(async () => {
    await db.delete(events).where(inArray(events.projectId, created));
    await db.delete(sessions).where(inArray(sessions.projectId, created));
    await db.delete(projects).where(inArray(projects.id, created));
    await app.close();
  });

  describe('la forme de la réponse', () => {
    it('rend la fenêtre en écho et une ligne par session', async () => {
      const body = await lire();

      // Les bornes reviennent parce que le lecteur doit comparer `startedAt` à
      // `from` pour reconnaître une session tronquée. Se fier à celles qu'il a
      // envoyées marcherait jusqu'au premier défaut appliqué côté serveur.
      expect(body.from).toBe(FENETRE.from);
      expect(body.to).toBe(FENETRE.to);
      expect(body.sessions).toHaveLength(3);
    });

    it('une ligne porte exactement les onze champs promis', async () => {
      const [alice] = (await lire()).sessions;

      expect(Object.keys(alice).sort()).toEqual([
        'activeMs',
        'campaign',
        'endedAt',
        'entryPath',
        'exit',
        'pageViews',
        'presencesStillOpen',
        'settled',
        'source',
        'startedAt',
        'visitorAlias',
      ]);
    });

    it('ne publie ni durationMs, ni les présences, ni la clé visiteur, ni le sessionId', async () => {
      const serialise = JSON.stringify(await lire());

      // `durationMs` se refait — les deux bornes sont là. `presences[]` est du
      // poids mort tant qu'aucune vue ne le demande.
      expect(serialise).not.toContain('durationMs');
      expect(serialise).not.toContain('presences"');

      // La clé visiteur ne sort pas du Core : ce qui descend jusqu'ici est un
      // alias tiré au hasard à chaque lecture.
      expect(serialise).not.toContain('visitorKey');

      // `sessionId` est parti avec l'arrivée de l'alias. Stable d'un appel à
      // l'autre, il aurait suffi à recoller les alias de deux réponses et à
      // leur rendre la permanence qu'on leur retire exprès.
      expect(serialise).not.toContain('sessionId');
    });

    it('rend le même nombre de sessions que le résumé global', async () => {
      // L'invariant qui compte. Les deux routes répondent au même périmètre par
      // deux chemins étrangers l'un à l'autre — un `count(distinct)` en SQL
      // d'un côté, un repli du journal de l'autre. S'ils divergeaient, deux
      // chiffres se contrediraient sur le même écran.
      const detail = await lire();
      const resume = await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics`)
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(200);

      expect((resume.body as { sessions: number }).sessions).toBe(
        detail.sessions.length,
      );
    });
  });

  /**
   * L'alias de visiteur, éprouvé sur ses deux propriétés — celle qui le rend
   * utile, et celle qui le rend acceptable.
   *
   * Le repli et la projection sont fixés ailleurs. Ce qui ne peut se voir
   * qu'ici, c'est l'accord avec le compte que le Core fait par un tout autre
   * chemin, et le fait que deux lectures ne rendent pas les mêmes jetons.
   */
  describe("l'alias de visiteur", () => {
    it('dédoublonne exactement comme le résumé, par un autre chemin', async () => {
      // L'invariant qui valide toute la chaîne d'un coup — jointure, aliasing,
      // repli, projection. Le résumé compte des clés distinctes en SQL sans
      // faire remonter une ligne ; le lecteur compte des alias distincts sur
      // les lignes. Les deux répondent au même périmètre, donc au même nombre.
      //
      // C'est ce qui autorise le dashboard à tracer des visiteurs uniques par
      // jour : si l'égalité tient sur la fenêtre, elle tient sur ses journées.
      const detail = await lire();
      const resume = await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics`)
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(200);

      const distincts = new Set(
        detail.sessions.map((row) => row.visitorAlias),
      ).size;

      expect(distincts).toBe(
        (resume.body as { uniqueVisitors: number }).uniqueVisitors,
      );
      // Et le fixture porte bien trois visiteurs : sans ça, l'égalité
      // ci-dessus tiendrait aussi entre deux zéros.
      expect(distincts).toBe(3);
    });

    it('ne rend pas les mêmes jetons à deux lectures de la même fenêtre', async () => {
      // La propriété qui distingue l'alias de la clé qu'il remplace. Un
      // compteur ou un `dense_rank()` SQL suffiraient à l'unicité et seraient
      // stables — deux réponses redeviendraient joignables, et rien dans le
      // code ne le dirait.
      const premier = await lire();
      const second = await lire();

      const jetons = (page: SessionsPageJson) =>
        page.sessions.map((row) => row.visitorAlias);

      expect(jetons(premier)).toHaveLength(3);
      expect(jetons(premier).sort()).not.toEqual(jetons(second).sort());
    });

    it('garde les comptes identiques d’une lecture à l’autre', async () => {
      // Le pendant du test précédent : les jetons changent, ce qu'on en déduit
      // non. Sans lui, une implémentation qui tirerait un alias par *ligne* au
      // lieu d'un par visiteur passerait le test du dessus haut la main.
      const premier = await lire();
      const second = await lire();

      expect(new Set(premier.sessions.map((row) => row.visitorAlias)).size).toBe(
        new Set(second.sessions.map((row) => row.visitorAlias)).size,
      );
    });

    it('n’a pas la forme de la clé qu’il remplace', async () => {
      // Garde-fou contre la « simplification » qui consisterait à renvoyer la
      // clé telle quelle : elle est en SHA-256 hexadécimal.
      for (const row of (await lire()).sessions) {
        expect(row.visitorAlias).not.toMatch(/^[0-9a-f]{64}$/);
        expect(row.visitorAlias).toMatch(/^[\w-]{12}$/);
      }
    });

    it('relie deux sessions du même visiteur dans la même journée', async () => {
      // Le cas qui justifie le champ, et que le fixture principal ne porte pas
      // — un visiteur par session. Ici la même personne revient quatre heures
      // plus tard : deux sessions, un seul visiteur. Sans l'alias, un lecteur
      // qui compte les lignes en verrait deux.
      const revenant = await newProject('revenant');

      await ingest('dave', 'page_view', '08:00', {}, revenant.apiKey);
      await ingest('dave', 'page_view', '12:00', {}, revenant.apiKey);

      const page = await lire(FENETRE, revenant.id);

      expect(page.sessions).toHaveLength(2);
      expect(new Set(page.sessions.map((row) => row.visitorAlias)).size).toBe(1);

      await db.delete(events).where(eq(events.projectId, revenant.id));
      await db.delete(sessions).where(eq(sessions.projectId, revenant.id));
    });
  });

  describe('ce que les lignes disent', () => {
    it('rend une session par visiteur, présences recollées', async () => {
      // Alice a deux présences séparées par seize minutes d'arrière-plan. C'est
      // une seule session — le découpage est celui du Core, pas des `page_leave`.
      const [alice] = (await lire()).sessions;

      expect(alice).toMatchObject({
        startedAt: at('09:00'),
        endedAt: at('09:26'),
        activeMs: 10 * MINUTE,
        pageViews: 2,
        presencesStillOpen: 0,
      });
    });

    it('garde une session sans vue de page, et lui donne une source nulle', async () => {
      // Carol a cliqué sans qu'aucun `page_view` n'accompagne le clic. Le Core
      // lui a ouvert une session — il ne sait pas ce qu'est une vue de page — et
      // la masquer ferait disparaître une activité bien réelle.
      const [carol] = (await lire({ from: at('09:15'), to: at('09:16') }))
        .sessions;

      expect(carol).toMatchObject({
        pageViews: 0,
        activeMs: 0,
        entryPath: null,
        // Surtout pas `direct` : « aucune provenance connue » et « aucune page
        // vue » sont deux choses différentes.
        source: null,
      });
    });

    it('n’invente aucune durée pour une présence restée ouverte', async () => {
      // La vue de bob n'a jamais été suivie d'une sortie. Son temps n'est pas
      // extrapolé jusqu'à `to` : il vaut zéro, et le compteur dit qu'il manque.
      const [bob] = (await lire({ from: at('09:10'), to: at('09:11') }))
        .sessions;

      expect(bob).toMatchObject({
        pageViews: 1,
        activeMs: 0,
        presencesStillOpen: 1,
      });
    });

    it('rend les lignes dans l’ordre où les sessions se sont ouvertes', async () => {
      const { sessions: lot } = await lire();

      // Chronologique, visiteurs entrelacés — l'ordre du journal, hérité de
      // l'ordre total du Core. Aucun tri n'est appliqué en route.
      expect(lot.map((row) => row.startedAt)).toEqual([
        at('09:00'),
        at('09:10'),
        at('09:15'),
      ]);
    });

    it('ne rend aucune ligne sur une fenêtre sans événement', async () => {
      const body = await lire({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-02T00:00:00.000Z',
      });

      // La fenêtre revient quand même : une réponse vide doit dire de quoi elle
      // est vide.
      expect(body.sessions).toEqual([]);
      expect(body.from).toBe('2026-09-01T00:00:00.000Z');
    });
  });

  describe('la provenance', () => {
    it('classe la session depuis le referrer de sa vue d’entrée', async () => {
      const [alice, bob] = (await lire()).sessions;

      expect(alice.source).toEqual({
        kind: 'search',
        name: 'google',
        label: 'Google',
        host: 'google.com',
      });
      expect(alice.entryPath).toBe('/');
      // Vue sans referrer : `direct` est une observation, pas un trou.
      // `host` y est `null` : une provenance directe n'a pas de site à montrer.
      expect(bob.source).toEqual({
        kind: 'direct',
        name: null,
        label: 'Direct',
        host: null,
      });
    });

    it('ne laisse pas la seconde vue d’alice écraser son entrée', async () => {
      // Le referrer de 09:20 est interne. S'il gagnait, la session basculerait
      // de `search` à `internal` et l'acquisition disparaîtrait du rapport.
      const [alice] = (await lire()).sessions;

      expect(alice.source).toEqual({
        kind: 'search',
        name: 'google',
        label: 'Google',
        host: 'google.com',
      });
      expect(alice.entryPath).toBe('/');
    });

    it('donne au lecteur de quoi ventiler ce qui n’est pas classé', async () => {
      // La fenêtre part de 09:15 et attrape les trois sessions dans trois états
      // différents — c'est le cas qui vaut d'être écrit en entier :
      //
      //   alice  commencée à 09:00, montre sa vue de 09:20 → classée internal,
      //          et `startedAt < from` avertit que ce n'est pas sa vraie entrée
      //   bob    commencé à 09:10, aucune vue dans la fenêtre → tronquée
      //   carol  commencée à 09:15 pile, aucune vue → réellement sans vue
      const body = await lire({ from: at('09:15'), to: at('09:30') });

      expect(compter(body)).toMatchObject({
        sessions: 3,
        attribuees: 1,
        tronquees: 1,
        sansVue: 1,
      });

      // Repérée par ce qu'elle porte, pas par son rang : l'ordre est celui du
      // **premier événement visible**, donc carol (09:15) passe devant alice
      // (09:20) alors que sa session est plus récente.
      const alice = body.sessions.find((row) => row.pageViews > 0);
      expect(alice?.source).toEqual({
        kind: 'internal',
        name: 'shop.test',
        label: 'shop.test',
        // Pour un `internal` comme pour un `referral`, le nom *est* le domaine.
        host: 'shop.test',
      });
    });

    it('n’attribue de source nulle qu’aux sessions sans vue de page', async () => {
      const { sessions: lot } = await lire();

      for (const row of lot) {
        expect(row.source === null).toBe(row.pageViews === 0);
      }
    });
  });

  describe('les bornes', () => {
    it('rend le vrai début d’une session que la fenêtre a tronquée', async () => {
      // Le seul champ de la réponse qui puisse sortir de la fenêtre, et c'est
      // voulu : sans lui, cette session serait indiscernable d'une session
      // réellement ouverte à 09:15.
      const from = at('09:15');
      const { sessions: lot } = await lire({ from, to: at('09:30') });
      const alice = lot.find((row) => row.pageViews > 0);

      expect(alice?.startedAt).toBe(at('09:00'));
      expect(new Date(alice?.startedAt ?? 0).getTime()).toBeLessThan(
        new Date(from).getTime(),
      );
      // Et la présence tronquée n'est pas rapatriée : six minutes visibles, pas
      // les dix de la session entière.
      expect(alice?.activeMs).toBe(6 * MINUTE);
    });

    it('n’étend jamais endedAt jusqu’à la borne haute', async () => {
      // Prolonger une session ouverte jusqu'à `to` ferait dépendre la mesure du
      // moment où on pose la question.
      const to = at('09:30');
      const { sessions: lot } = await lire({ from: at('09:00'), to });

      for (const row of lot) {
        expect(new Date(row.endedAt).getTime()).toBeLessThan(
          new Date(to).getTime(),
        );
      }
    });

    it('inclut la borne basse et exclut la borne haute', async () => {
      // `[from, to)`, comme partout ailleurs. La vue d'alice de 09:00 entre, sa
      // sortie de 09:04 non.
      const body = await lire({ from: at('09:00'), to: at('09:04') });

      expect(compter(body).pageViews).toBe(1);
      expect(body.sessions[0].presencesStillOpen).toBe(1);
    });

    it('une milliseconde de plus fait entrer la sortie', async () => {
      const body = await lire({
        from: at('09:00'),
        to: '2026-08-22T09:04:00.001Z',
      });

      expect(body.sessions[0].activeMs).toBe(4 * MINUTE);
      expect(body.sessions[0].presencesStillOpen).toBe(0);
    });

    it('deux fenêtres adjacentes ne comptent pas deux fois une vue', async () => {
      // Les vues sont franchement additives : un événement ponctuel tombe d'un
      // seul côté d'une borne. Les sessions ne le sont pas — alice apparaît des
      // deux côtés — et c'est précisément pour ça que la route ne somme rien.
      const matin = await lire({ from: at('09:00'), to: at('09:15') });
      const suite = await lire({ from: at('09:15'), to: at('09:30') });
      const entier = await lire({ from: at('09:00'), to: at('09:30') });

      expect(compter(matin).pageViews + compter(suite).pageViews).toBe(
        compter(entier).pageViews,
      );
      expect(compter(matin).sessions + compter(suite).sessions).toBeGreaterThan(
        compter(entier).sessions,
      );
    });
  });

  describe('le cloisonnement et la validation', () => {
    it('ne voit rien d’un autre projet', async () => {
      const voisin = await newProject('voisin');

      // Même User-Agent que chez nous : la clé visiteur est dérivée par projet,
      // et la lecture est cloisonnée par projet.
      await ingest('alice', 'page_view', '09:00', {}, voisin.apiKey);

      expect((await lire(FENETRE, voisin.id)).sessions).toHaveLength(1);
      expect((await lire()).sessions).toHaveLength(3);

      await db.delete(events).where(eq(events.projectId, voisin.id));
      await db.delete(sessions).where(eq(sessions.projectId, voisin.id));
    });

    it('refuse `interval`, qui n’existe plus', async () => {
      // Le paramètre a existé et il est parti avec la série qu'il produisait :
      // regrouper dans le temps appartient au lecteur, qui reçoit des lignes
      // datées. L'accepter en l'ignorant laisserait croire à un découpage qui
      // n'a pas eu lieu.
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/sessions`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, interval: 'day' })
        .expect(400);
    });

    it('applique la fenêtre par défaut quand elle est absente', async () => {
      // Sept jours, comme la route voisine — le défaut vit dans
      // `analytics-query.dto.ts` et n'est pas redéclaré, précisément pour que
      // deux routes ne puissent pas diverger en silence.
      const body = await lire({});

      const largeur =
        new Date(body.to).getTime() - new Date(body.from).getTime();
      expect(largeur).toBe(7 * 24 * 60 * MINUTE);
    });

    it('refuse une borne malformée', async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/sessions`)
        .set('Cookie', cookies)
        .query({ from: 'hier', to: FENETRE.to })
        .expect(400);
    });

    it('refuse une fenêtre à l’envers', async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/sessions`)
        .set('Cookie', cookies)
        .query({ from: FENETRE.to, to: FENETRE.from })
        .expect(400);
    });

    it('rend 404 sur un projectId qui n’est pas un UUID', async () => {
      // C'était un 400 tant que la route était publique : le pipe Zod validait
      // le paramètre. Depuis `ProjectMemberGuard`, c'est un 404 — et le
      // changement est voulu. Les guards tournent avant les pipes, et le guard
      // ne distingue pas « malformé » de « inconnu » de « pas à vous » : les
      // trois ne désignent aucun projet accessible, et répondre différemment
      // renseignerait un attaquant sur les identifiants qui existent.
      await request(app.getHttpServer())
        .get('/v1/projects/pas-un-uuid/analytics/sessions')
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(404);
    });

    it('répond 404 pour un projet inconnu', async () => {
      await request(app.getHttpServer())
        .get(
          '/v1/projects/00000000-0000-4000-8000-000000000000/analytics/sessions',
        )
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(404);
    });

    it('ne répond plus sur /sources', async () => {
      // La route a fusionné dans celle-ci à l'étape 33. Un 404 explicite vaut
      // mieux qu'une route laissée en place qui rendrait une forme périmée.
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics/sources`)
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(404);
    });
  });

  /**
   * `exit` et `settled` : les deux champs qui rendent la carte Pages calculable
   * chez le lecteur.
   *
   * Un projet à part, avec ses propres visiteurs. Le fixture principal est calé
   * sur des comptes de sessions qu'une visite de plus ferait bouger partout, et
   * ce qui se joue ici — une sortie, une clôture — demande des instants choisis.
   */
  describe('la sortie et la clôture', () => {
    let sorties: string;

    const ligne = async (visiteur: string) => {
      const { sessions } = await lire(FENETRE, sorties);

      // Une session par visiteur ici, et l'ordre du journal est chronologique
      // sur l'ouverture : on retrouve la ligne par sa page d'entrée.
      return sessions.find((row) => row.entryPath === visiteur);
    };

    beforeAll(async () => {
      const projet = await newProject('sorties');
      sorties = projet.id;

      const poser = (
        visiteur: string,
        type: string,
        heure: string,
        attributes: Record<string, unknown> = {},
        properties?: Record<string, unknown>,
      ) => ingest(visiteur, type, heure, attributes, projet.apiKey, properties);

      // `parti` lit deux pages puis clique vers Stripe : la sortie est connue
      // des deux côtés — d'où on est parti, et vers où.
      await poser('parti', 'page_view', '09:00', { 'page.path': '/parti' });
      await poser('parti', 'page_view', '09:05', { 'page.path': '/panier' });
      await poser('parti', 'outbound_click', '09:06', {}, {
        'link.origin': 'https://checkout.stripe.com',
      });

      // `reste` s'éteint sur place : on sait sur quelle page, pas vers où.
      await poser('reste', 'page_view', '09:10', { 'page.path': '/reste' });
      await poser('reste', 'page_view', '09:12', { 'page.path': '/prix' });
    });

    it('rend la dernière page vue et le site vers lequel on est parti', async () => {
      expect((await ligne('/parti'))?.exit).toEqual({
        path: '/panier',
        outbound: 'https://checkout.stripe.com',
      });
    });

    it('laisse `outbound` nul quand la session s’éteint sur le site', async () => {
      // Ce qui ne dit **pas** que le visiteur est resté : fermer l'onglet et
      // taper une autre adresse se ressemblent depuis ici.
      expect((await ligne('/reste'))?.exit).toEqual({
        path: '/prix',
        outbound: null,
      });
    });

    it('ne compte pas le clic sortant comme une vue de page', async () => {
      expect((await ligne('/parti'))?.pageViews).toBe(2);
    });

    it('marque closes les sessions loin de la borne haute', async () => {
      // Le fixture pose tout le matin, la fenêtre s'arrête à minuit : les deux
      // sessions sont largement au-delà des trente minutes.
      const { sessions } = await lire(FENETRE, sorties);

      expect(sessions.every((row) => row.settled)).toBe(true);
    });

    it('ne marque pas close une session au bord de la fenêtre', async () => {
      // Fenêtre resserrée juste après le dernier événement de `reste` : il
      // tombe alors à moins de trente minutes de `to`, donc un événement peut
      // encore le rejoindre. C'est exactement l'exclusion que `settledSessions`
      // applique sur la fenêtre entière.
      const { sessions } = await lire(
        { from: FENETRE.from, to: at('09:20') },
        sorties,
      );

      expect(sessions.every((row) => row.settled)).toBe(false);
    });
  });
});

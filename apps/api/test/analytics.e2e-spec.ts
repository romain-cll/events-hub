import type { INestApplication } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { analyticsSummarySchema } from '@events-hub/api-contract';

import {
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  TEST_ORIGIN,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * Le module Analytics, éprouvé par sa route.
 *
 * `test/top-values.e2e-spec.ts` vérifie que le Core sait grouper une clé JSON.
 * Ce test-ci vérifie l'autre moitié du contrat : qu'*Analytics* est bien le
 * seul à décider que `page_view` + `attributes['page.path']` se lit « pages les
 * plus vues », et qu'il rend ce classement sous le nom `topPages`.
 *
 * Il passe par la route HTTP plutôt que par le service : ce qui est en jeu est
 * la chaîne entière — ingestion générique, primitive du Core, interprétation du
 * module, sérialisation. Un test qui appellerait `summarize()` directement
 * laisserait le contrat de l'API hors couverture, alors que c'est lui que le
 * dashboard consomme.
 *
 * Les événements sont écrits **par la route d'ingestion** : la clé visiteur est
 * donc dérivée pour de vrai, et faire varier le User-Agent est ce qui donne des
 * visiteurs distincts.
 *
 * `pnpm test:e2e` demande une base accessible ; tout ce qui est créé ici est
 * supprimé à la fin.
 */

/** Un instant fixe, pour que la fenêtre de lecture soit déterministe. */
const OCCURRED_AT = '2026-08-22T12:00:00.000Z';
/** Deux jours plus tard : dans le projet, hors de la fenêtre interrogée. */
const HORS_FENETRE = '2026-08-24T12:00:00.000Z';

const FENETRE = {
  from: '2026-08-22T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
};

/** Ce que le module rend pour une page — la forme que le Core produit. */
interface TopPage {
  value: string;
  events: number;
  visitors: number;
}

interface SummaryResponse {
  from: string;
  to: string;
  sessions: number;
  pageViews: number;
  uniqueVisitors: number;
  bounces: number;
  settledSessions: number;
  topPages: TopPage[];
}

/** Ce dont le repli des lignes a besoin pour refaire le calcul du résumé. */
interface SessionLine {
  startedAt: string;
  endedAt: string;
  pageViews: number;
}

describe('GET /v1/projects/:projectId/analytics — topPages (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projectId: string;
  let apiKey: string;
  /** Le compte qui lit : membre de l'organisation des projets de test. */
  let cookies: string[];
  /** Tous les projets créés ici, pour un nettoyage qui n'en oublie aucun. */
  const created: string[] = [];

  const newProject = async (label: string) => {
    const project = await createProject(db, {
      name: `e2e analytics ${label} ${new Date().toISOString()}`,
    });

    created.push(project.id);
    return project;
  };

  const ingest = (
    visiteur: string,
    type: string,
    attributes: Record<string, unknown> = {},
    occurredAt: string = OCCURRED_AT,
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
        properties: {},
      })
      .expect(201);

  const page = (
    visiteur: string,
    path: string,
    occurredAt?: string,
    project?: string,
  ) =>
    ingest(visiteur, 'page_view', { 'page.path': path }, occurredAt, project);

  /** La lecture telle que le dashboard la fait. */
  const summarize = async (
    query: Record<string, string> = FENETRE,
    project: string = projectId,
  ) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${project}/analytics`)
      .set('Cookie', cookies)
      .query(query)
      .expect(200);

    // Chaque lecture de ce fichier passe par ici : le contrat est donc vérifié
    // sur toutes les fenêtres et tous les projets qu'il éprouve, pas seulement
    // sur un cas nominal choisi.
    expectMatchesContract(response.body, analyticsSummarySchema);

    return response.body as SummaryResponse;
  };

  const topPages = async (
    query?: Record<string, string>,
    project?: string,
  ): Promise<TopPage[]> => (await summarize(query, project)).topPages;

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);

    // Les analytics ne sont plus publiques : il faut un compte, et il faut
    // qu'il soit membre de l'organisation qui porte les projets de test.
    const reader = await signUp(app);
    cookies = reader.cookies;
    await joinOrganization(db, await organizationId(db), reader.id);
    const principal = await newProject('pages');
    projectId = principal.id;
    apiKey = principal.apiKey;

    // « / » : 4 vues, 3 visiteurs — le compte et l'audience diffèrent.
    await page('visiteur-a', '/');
    await page('visiteur-a', '/');
    await page('visiteur-b', '/');
    await page('visiteur-c', '/');
    // « /pricing » : 2 vues, 2 visiteurs.
    await page('visiteur-a', '/pricing');
    await page('visiteur-b', '/pricing');
    // Trois pages à égalité, pour éprouver le départage.
    await page('visiteur-a', '/docs');
    await page('visiteur-a', '/beta');
    await page('visiteur-a', '/alpha');

    // Ce qui ne doit pas compter comme une page vue :
    // un autre type, qui porte pourtant un chemin,
    await ingest('visiteur-a', 'click', { 'page.path': '/pricing' });
    // deux `page_view` sans chemin exploitable,
    await ingest('visiteur-a', 'page_view');
    await ingest('visiteur-a', 'page_view', { 'page.path': null });
    // et une vue hors de la fenêtre interrogée.
    await page('visiteur-a', '/pricing', HORS_FENETRE);
  });

  afterAll(async () => {
    await db.delete(events).where(inArray(events.projectId, created));
    await db.delete(sessions).where(inArray(sessions.projectId, created));
    await db.delete(projects).where(inArray(projects.id, created));
    await app.close();
  });

  describe('classer', () => {
    it('rend les pages les plus vues, avec leurs vues et leurs visiteurs', async () => {
      // Une seule assertion pour toute la sémantique du classement : plusieurs
      // pages, plusieurs visiteurs sur une même page, et l'ordre.
      expect(await topPages()).toEqual([
        { value: '/', events: 4, visitors: 3 },
        { value: '/pricing', events: 2, visitors: 2 },
        { value: '/alpha', events: 1, visitors: 1 },
        { value: '/beta', events: 1, visitors: 1 },
        { value: '/docs', events: 1, visitors: 1 },
      ]);
    });

    it('départage les égalités de façon déterministe', async () => {
      // `/alpha`, `/beta` et `/docs` ont le même compte. Sans second critère,
      // Postgres serait libre de les rendre dans n'importe quel ordre, et deux
      // chargements du dashboard ne montreraient pas la même liste.
      const [premier, second] = await Promise.all([topPages(), topPages()]);

      expect(second).toEqual(premier);
    });

    it('rend exactement les neuf champs promis, et pas de série', async () => {
      // `interval` et `timeseries` ont existé jusqu'à l'étape 33. Le découpage
      // dans le temps appartient au lecteur, qui reçoit des sessions datées par
      // la route voisine — cette route-ci ne rend que des agrégats de période.
      expect(Object.keys(await summarize(FENETRE)).sort()).toEqual([
        // Les sessions de robots, retirées de tous les autres compteurs par
        // `EventStore.where()`. Rendu pour que le retrait ne soit pas muet.
        'botSessions',
        'bounces',
        'from',
        'pageViews',
        'sessions',
        'settledSessions',
        'to',
        'topPages',
        'uniqueVisitors',
      ]);
    });

    it('refuse `interval`, qui n’existe plus', async () => {
      // Un signet qui porte encore le paramètre doit se voir, pas produire une
      // réponse silencieusement différente de ce qu'il demande.
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, interval: 'day' })
        .expect(400);
    });

    it('compte les sessions de la fenêtre, tous types confondus', async () => {
      // Le périmètre est celui de la route voisine — pas celui de `pageViews`.
      // Filtrer sur `page_view` ici ferait disparaître du résumé toute session
      // sans vue de page, c'est-à-dire précisément celles qu'on tient à ne pas
      // taire. L'égalité avec la liste détaillée est éprouvée dans
      // `sessions-route.e2e-spec.ts`.
      const resume = await summarize(FENETRE);

      expect(resume.sessions).toBeGreaterThan(0);
      expect(resume.sessions).toBeGreaterThanOrEqual(resume.uniqueVisitors);
    });
  });

  describe('écarter', () => {
    it('ne compte que les page_view', async () => {
      // Un `click` porte pourtant `/pricing` : s'il comptait, la page passerait
      // à 3 vues.
      const pricing = (await topPages()).find(
        (row) => row.value === '/pricing',
      );

      expect(pricing).toEqual({ value: '/pricing', events: 2, visitors: 2 });
    });

    it('ignore les page_view sans page.path', async () => {
      const { pageViews, topPages: classement } = await summarize();
      const classees = classement.reduce((somme, row) => somme + row.events, 0);

      // 11 pages vues dans la fenêtre, dont 2 sans chemin : le classement en
      // couvre 9. L'écart est visible en comparant au total, qui reste rendu à
      // part — c'est ce qui rend l'exclusion honnête plutôt que silencieuse.
      expect(pageViews).toBe(11);
      expect(classees).toBe(9);
      expect(classement.map((row) => row.value)).not.toContain(null);
    });

    it('respecte la fenêtre demandée', async () => {
      // La vue hors fenêtre existe : élargir `to` la fait apparaître.
      const large = await topPages({
        from: FENETRE.from,
        to: '2026-08-25T00:00:00.000Z',
      });

      expect(large[1]).toEqual({ value: '/pricing', events: 3, visitors: 2 });

      // Et resserrer `from` après les événements vide le classement.
      expect(
        await topPages({ from: '2026-08-23T00:00:00.000Z', to: FENETRE.to }),
      ).toEqual([]);
    });

    it("ne voit rien d'un autre projet", async () => {
      const voisin = await newProject('voisin');
      await page('visiteur-a', '/secret', OCCURRED_AT, voisin.apiKey);

      // Chacun ne voit que le sien : le cloisonnement ne dépend pas du module,
      // il est porté par le scope que le Core applique.
      expect((await topPages()).map((row) => row.value)).not.toContain(
        '/secret',
      );
      expect(await topPages(FENETRE, voisin.id)).toEqual([
        { value: '/secret', events: 1, visitors: 1 },
      ]);
    });
  });

  describe('borner', () => {
    it('rend au plus dix pages', async () => {
      const large = await newProject('douze-pages');

      for (let i = 0; i < 12; i += 1) {
        await page(
          'visiteur-a',
          `/page-${String(i).padStart(2, '0')}`,
          OCCURRED_AT,
          large.apiKey,
        );
      }

      expect(await topPages(FENETRE, large.id)).toHaveLength(10);
    });

    it("n'expose pas la borne dans l'API", async () => {
      // Le nombre de pages retenues est une décision du module, pas un réglage
      // de l'appelant. `strictObject` fait qu'un paramètre inconnu est refusé
      // plutôt qu'ignoré — sinon le dashboard croirait l'avoir changé.
      await request(app.getHttpServer())
        .get(`/v1/projects/${projectId}/analytics`)
        .set('Cookie', cookies)
        .query({ ...FENETRE, limit: '50' })
        .expect(400);
    });
  });

  /**
   * `bounces` et `settledSessions` : les deux comptes dont le taux de rebond
   * est le rapport.
   *
   * Un projet à part, avec ses cinq visiteurs, parce que la règle se joue sur
   * des **instants** : le fixture principal pose tout à midi, et il n'y aurait
   * là aucune session en cours à écarter.
   *
   * Les cinq cas sont ceux qui décident du chiffre, et il n'y en a pas d'autre :
   *
   * | visiteur   | ce qu'il fait                  | rebond | dénominateur |
   * | ---------- | ------------------------------ | ------ | ------------ |
   * | `rebond-a` | une vue, à midi                | oui    | oui          |
   * | `rebond-b` | une vue, à midi                | oui    | oui          |
   * | `visite`   | deux vues, à cinq minutes      | non    | oui          |
   * | `en-cours` | une vue à 23 h 45              | non    | **non**      |
   * | `sans-vue` | un clic, aucune vue            | non    | **non**      |
   * | `a-cheval` | ouverte la veille, une vue ici | non    | **non**      |
   *
   * Les deux dernières colonnes ne se déduisent pas l'une de l'autre : sortir
   * du dénominateur n'est pas « ne pas rebondir ». `a-cheval` en est le cas le
   * plus retors — vue de sa fenêtre, elle *ressemble* à un rebond, et c'est
   * exactement pourquoi on refuse de trancher.
   */
  describe('rebonds', () => {
    /** Trente minutes avant `to`, la vue de `en-cours` tombe après. */
    const TARD = '2026-08-22T23:45:00.000Z';
    const PLUS_TARD = '2026-08-22T12:05:00.000Z';
    /** Avant `from` : ce que la fenêtre ne montrera pas d'`a-cheval`. */
    const VEILLE = '2026-08-21T23:50:00.000Z';
    /** Quinze minutes après, donc la même session, mais dans la fenêtre. */
    const APRES_MINUIT = '2026-08-22T00:05:00.000Z';

    let rebonds: string;

    beforeAll(async () => {
      const projet = await newProject('rebonds');
      rebonds = projet.id;

      await page('rebond-a', '/', OCCURRED_AT, projet.apiKey);
      await page('rebond-b', '/pricing', OCCURRED_AT, projet.apiKey);

      // Deux vues à cinq minutes d'écart : une seule session, pas un rebond.
      await page('visite', '/', OCCURRED_AT, projet.apiKey);
      await page('visite', '/pricing', PLUS_TARD, projet.apiKey);

      // Quinze minutes avant la borne haute : un événement peut encore la
      // rejoindre, donc on ne se prononce pas.
      await page('en-cours', '/', TARD, projet.apiKey);

      // Une session sans aucune vue de page — rien dont on soit parti.
      await ingest(
        'sans-vue',
        'click',
        { 'page.path': '/' },
        OCCURRED_AT,
        projet.apiKey,
      );

      // Une session ouverte avant `from`, poursuivie dans la fenêtre : quinze
      // minutes d'écart, donc une seule session dont `startedAt` est la veille.
      // La fenêtre n'en montre qu'une vue — celle d'avant minuit est coupée par
      // la borne basse, pas par le comportement du visiteur.
      await page('a-cheval', '/', VEILLE, projet.apiKey);
      await page('a-cheval', '/pricing', APRES_MINUIT, projet.apiKey);
    });

    it('compte les sessions terminées à une seule vue', async () => {
      const resume = await summarize(FENETRE, rebonds);

      expect(resume.bounces).toBe(2);
      expect(resume.settledSessions).toBe(3);
    });

    it('écarte du dénominateur ce sur quoi il ne se prononce pas', async () => {
      const resume = await summarize(FENETRE, rebonds);

      // Six sessions au total, trois dans le dénominateur : `en-cours`,
      // `sans-vue` et `a-cheval` en sont sorties. L'écart n'est pas une perte,
      // et il doit rester lisible — c'est lui qui interdit de diviser par
      // `sessions`.
      expect(resume.sessions).toBe(6);
      expect(resume.settledSessions).toBeLessThan(resume.sessions);
    });

    it('écarte la session dont il n’a pas vu le début', async () => {
      // La symétrique de `en-cours`, et le cas que le tampon de minuit a rendu
      // possible : `a-cheval` a vu deux pages, la fenêtre n'en montre qu'une.
      // La compter ferait un rebond d'une visite qui n'en est pas un — et
      // gonflerait le taux tous les jours, sur la même tranche horaire.
      const resume = await summarize(FENETRE, rebonds);

      expect(resume.bounces).toBe(2);

      // Élargir la fenêtre à la veille rend la session entière : elle entre
      // alors dans le dénominateur, et n'est toujours pas un rebond.
      const large = await summarize(
        { from: '2026-08-21T00:00:00.000Z', to: FENETRE.to },
        rebonds,
      );

      expect(large.settledSessions).toBe(resume.settledSessions + 1);
      expect(large.bounces).toBe(resume.bounces);
    });

    it('donne le même résultat que le repli des lignes détaillées', async () => {
      // L'invariant qui compte, sur le modèle de celui qui tient `sessions`
      // dans `sessions-route.e2e-spec.ts`. Les deux chemins sont étrangers l'un
      // à l'autre — un `group by` en SQL ici, `sessionsOf()` en TypeScript là —
      // et c'est précisément pourquoi ils peuvent diverger sans que rien ne le
      // dise. Le repli refait ci-dessous est celui que le dashboard applique.
      const detail = await request(app.getHttpServer())
        .get(`/v1/projects/${rebonds}/analytics/sessions`)
        .set('Cookie', cookies)
        .query(FENETRE)
        .expect(200);

      const { sessions: lignes } = detail.body as { sessions: SessionLine[] };
      const clotureAvant = new Date(FENETRE.to).getTime() - 30 * 60 * 1000;
      const ouverteApres = new Date(FENETRE.from).getTime();

      const terminees = lignes.filter(
        (ligne) =>
          new Date(ligne.endedAt).getTime() < clotureAvant &&
          // La borne basse, que la ligne porte elle aussi : `startedAt` est le
          // début **réel**, même antérieur à `from`. C'est ce qui permet au
          // lecteur de refaire l'exclusion sans rien savoir de plus.
          new Date(ligne.startedAt).getTime() >= ouverteApres &&
          ligne.pageViews >= 1,
      );

      const resume = await summarize(FENETRE, rebonds);

      expect(resume.settledSessions).toBe(terminees.length);
      expect(resume.bounces).toBe(
        terminees.filter((ligne) => ligne.pageViews === 1).length,
      );
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { EventStore } from '../src/events/event-store.service';
import { createProject, TEST_ORIGIN } from './fixtures';
import { createTestApp } from './harness';

/**
 * La promesse d'Event Stream générique, éprouvée par le comportement.
 *
 * `src/core/core-boundary.spec.ts` vérifie la même chose en lisant les sources :
 * le Core ne nomme aucun type et ne décide rien à partir d'un type. Ce test-ci
 * est son pendant vivant — il fait réellement traverser tout le pipeline à des
 * événements que le Core n'a jamais vus, et vérifie qu'il les ingère, les
 * stocke et les restitue exactement comme les autres.
 *
 * Les deux se complètent et aucun ne remplace l'autre : le test de sources
 * attrape un aiguillage écrit mais jamais atteint, celui-ci attrape une
 * connaissance métier qui se serait logée ailleurs que dans une comparaison —
 * une colonne dédiée, un défaut appliqué à un seul type, une validation
 * conditionnelle.
 *
 * `pnpm test:e2e` demande une base accessible ; les données créées sont
 * supprimées à la fin.
 */

/** Un instant fixe, pour que les fenêtres de lecture soient déterministes. */
const OCCURRED_AT = '2026-08-22T12:00:00.000Z';
const WINDOW = {
  from: new Date('2026-08-22T00:00:00.000Z'),
  to: new Date('2026-08-23T00:00:00.000Z'),
};

/** Le User-Agent de ce test, pour vérifier qu'il ne se retrouve nulle part. */
const USER_AGENT = 'sonde-e2e-contrat-generique/1.0';

/**
 * Le contexte navigateur, identique sur les cinq événements — c'est le SDK qui
 * le garantit, et c'est justement ce qui doit ressortir intact : le Core range
 * ce sac sans jamais l'ouvrir.
 */
const ATTRIBUTES = {
  'page.path': '/resultats',
  'page.url': 'http://localhost:4000/resultats',
  'page.referrer': 'https://recherche.test/?q=analytics',
  'browser.language': 'fr-FR',
  'screen.width': 1512,
  'screen.height': 982,
};

/**
 * Ce que le SDK produit réellement — les `properties` sont celles relevées sur
 * une visite instrumentée, pas des exemples inventés.
 */
const SDK_EVENTS: [string, Record<string, unknown>][] = [
  [
    'page_view',
    { 'navigation.type': 'push_state', 'navigation.from': '/example/' },
  ],
  [
    'click',
    {
      'element.tag': 'button',
      'element.id': 'filtrer',
      'element.name': 'filtrer',
      'element.type': 'button',
    },
  ],
  [
    'submit',
    {
      'form.id': 'recherche',
      'form.name': 'recherche',
      'form.action': 'http://localhost:4000/recherche',
      'form.method': 'get',
    },
  ],
  [
    'outbound_click',
    {
      'element.tag': 'a',
      'element.id': 'sortie',
      'element.href': 'https://example.com/',
      'link.origin': 'https://example.com',
    },
  ],
  ['page_leave', { 'leave.reason': 'outbound_click' }],
];

/**
 * Des types que le Core n'a jamais vus, et qu'il ne doit pas avoir besoin de
 * connaître. Les cinq derniers sont ceux de la roadmap : le jour où on les
 * émettra, l'ingestion ne doit pas bouger d'une ligne.
 */
const JAMAIS_VUS = [
  'something_we_have_never_heard_of',
  'error',
  'api_call',
  'ai_agent_visit',
  'webhook',
  'deployment',
];

interface EventResponse {
  id: string;
  projectId: string;
  type: string;
  source: string;
  occurredAt: string;
  attributes: Record<string, unknown>;
  properties: Record<string, unknown>;
}

const asEvent = (response: request.Response) => response.body as EventResponse;

describe("contrat générique de l'Event Stream (e2e)", () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let store: EventStore;
  let projectId: string;
  let apiKey: string;

  const post = (type: string, properties: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', USER_AGENT)
      .send({
        apiKey,
        type,
        occurredAt: OCCURRED_AT,
        attributes: ATTRIBUTES,
        properties,
      });

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);
    // `EventStore` est exporté par `EventsModule` : c'est la surface de lecture
    // que le Core offre aux modules, donc celle qu'on éprouve ici.
    store = app.get(EventStore);

    const project = await createProject(db, {
      name: `e2e event-stream ${new Date().toISOString()}`,
    });
    projectId = project.id;
    apiKey = project.apiKey;
  });

  afterAll(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await app.close();
  });

  describe('ingérer', () => {
    it.each(SDK_EVENTS)(
      'accepte « %s » et le rend tel quel',
      async (type, properties) => {
        const response = await post(type, properties).expect(201);

        expect(asEvent(response)).toMatchObject({
          projectId,
          type,
          occurredAt: OCCURRED_AT,
          attributes: ATTRIBUTES,
          properties,
        });
      },
    );

    it.each(JAMAIS_VUS)(
      'accepte « %s », un type dont le Core ignore tout',
      async (type) => {
        const response = await post(type, {
          quoiQueCeSoit: { imbrique: [1, 'deux', null] },
        }).expect(201);

        expect(asEvent(response).type).toBe(type);
        expect(asEvent(response).properties).toEqual({
          quoiQueCeSoit: { imbrique: [1, 'deux', null] },
        });
      },
    );

    it('rend la même forme de réponse quel que soit le type', async () => {
      const connu = await post('page_view', SDK_EVENTS[0][1]).expect(201);
      const inconnu = await post('ai_agent_visit').expect(201);

      // Une réponse qui s'enrichirait pour les types « connus » trahirait un
      // traitement particulier quelque part.
      expect(Object.keys(asEvent(inconnu)).sort()).toEqual(
        Object.keys(asEvent(connu)).sort(),
      );
    });
  });

  describe('stocker', () => {
    /**
     * Un seul passage pour toute la section : on écrit une fois tous les types,
     * puis on regarde ce que la base contient réellement — pas ce que l'API a
     * bien voulu renvoyer.
     */
    let rows: (typeof events.$inferSelect)[];

    beforeAll(async () => {
      for (const [type, properties] of SDK_EVENTS) await post(type, properties);
      for (const type of JAMAIS_VUS) await post(type);

      rows = await db
        .select()
        .from(events)
        .where(eq(events.projectId, projectId));
    });

    it('écrit chaque type, connu ou non', () => {
      const attendus = [...SDK_EVENTS.map(([type]) => type), ...JAMAIS_VUS];

      expect(new Set(rows.map((row) => row.type))).toEqual(new Set(attendus));
    });

    it('range les attributes sans les lire ni les réécrire', () => {
      // Même sac sur tous les types : ce qui ressort de `jsonb` est exactement
      // ce qui est entré, sans clé ajoutée, retirée ni normalisée.
      for (const row of rows) expect(row.attributes).toEqual(ATTRIBUTES);
    });

    it('applique le même traitement de confidentialité à tous les types', async () => {
      // Une seule clé visiteur pour toutes les lignes : la même identité réseau
      // donne la même clé, que le type soit `page_view` ou `webhook`. Un
      // traitement qui sauterait l'étape pour les types inconnus produirait ici
      // une clé vide ou une deuxième valeur.
      //
      // La clé ne vit plus sur l'événement mais sur sa session : on la lit donc
      // là où elle est. Que toutes les lignes partagent une seule session est
      // d'ailleurs la conséquence directe — une clé différente aurait ouvert une
      // session de plus.
      const clesDeSession = await db
        .select({ visitorKey: sessions.visitorKey })
        .from(sessions)
        .where(eq(sessions.projectId, projectId));

      expect(new Set(rows.map((row) => row.sessionId)).size).toBe(1);
      expect(clesDeSession).toHaveLength(1);
      expect(clesDeSession[0].visitorKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it("ne stocke ni l'IP ni le User-Agent, quel que soit le type", () => {
      // Ils servent à dériver la clé puis sortent de portée. S'ils atterrissaient
      // quelque part — une colonne, un attribut, un log de reprise — la promesse
      // « ce qu'on ne stocke pas ne peut pas fuiter » tomberait.
      const contenu = JSON.stringify(rows);

      expect(contenu).not.toContain(USER_AGENT);
      expect(contenu).not.toContain('127.0.0.1');
    });

    it('remplit les mêmes colonnes pour tous les types', () => {
      const forme = (row: (typeof rows)[number]) =>
        Object.entries(row)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([column]) => column)
          .sort();

      const formes = new Set(rows.map((row) => JSON.stringify(forme(row))));
      expect(formes.size).toBe(1);
    });
  });

  describe('restituer', () => {
    it("compte un type que le Core n'a jamais vu, sans modification", async () => {
      await post('ai_agent_visit');

      // `EventStore` filtre une colonne, il n'interprète rien. C'est ce qui
      // permettra à un futur module de compter ses propres types sans que le
      // Core apprenne quoi que ce soit.
      const compte = await store.countEvents({
        projectId,
        ...WINDOW,
        types: ['ai_agent_visit'],
      });

      expect(compte).toBeGreaterThan(0);
    });

    it('compte tous les types confondus quand aucun type n’est demandé', async () => {
      const [avecType, tous] = await Promise.all([
        store.countEvents({ projectId, ...WINDOW, types: ['page_view'] }),
        store.countEvents({ projectId, ...WINDOW }),
      ]);

      expect(tous).toBeGreaterThan(avecType);
    });

    it('compte les sessions d’un type inconnu comme celles d’un type connu', async () => {
      // Le découpage en journées a existé ici jusqu'à l'étape 33 et il est
      // parti avec `countEventsByDay` : regrouper dans le temps appartient au
      // lecteur. Ce que la généricité doit encore prouver, c'est qu'un type que
      // le Core n'a jamais vu traverse les mêmes primitives.
      const sessions = await store.countSessions({
        projectId,
        ...WINDOW,
        types: ['webhook'],
      });

      expect(sessions).toBeGreaterThan(0);
      expect(sessions).toBeLessThanOrEqual(
        await store.countSessions({ projectId, ...WINDOW }),
      );
    });

    it('compte un visiteur une fois, quels que soient les types émis', async () => {
      // Toutes les écritures de ce fichier partagent la même identité réseau :
      // l'audience est de un, même après une douzaine de types différents.
      const visiteurs = await store.countVisitors({ projectId, ...WINDOW });

      expect(visiteurs).toBe(1);
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { events, projects, sessions } from '../src/database/schema';
import { EventStore, type EventScope } from '../src/events/event-store.service';
import { createProject, TEST_ORIGIN } from './fixtures';
import { createTestApp } from './harness';

/**
 * `EventStore.topValues()`, éprouvée contre un vrai Postgres.
 *
 * Il n'y a pas de test unitaire de cette méthode, et c'est délibéré : tout ce
 * qu'elle fait est du SQL. La tester contre un double de Drizzle reviendrait à
 * affirmer que le SQL généré ressemble à celui qu'on a écrit — ce qui ne dit
 * rien de ce que Postgres en fait. Le groupement, l'exclusion des `null`, la
 * coupe du `limit` et le déterminisme de l'ordre ne s'observent qu'ici.
 *
 * Les événements sont écrits **par la route d'ingestion**, pas insérés à la
 * main : la clé visiteur est donc dérivée pour de vrai. Faire varier le
 * User-Agent est ce qui donne des visiteurs distincts — c'est la seule des
 * trois composantes du HMAC qu'un test puisse choisir.
 */

const OCCURRED_AT = '2026-08-22T12:00:00.000Z';
const HORS_FENETRE = '2026-08-25T12:00:00.000Z';

const WINDOW = {
  from: new Date('2026-08-22T00:00:00.000Z'),
  to: new Date('2026-08-23T00:00:00.000Z'),
};

describe('EventStore.topValues (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let store: EventStore;
  let projectId: string;
  let apiKey: string;
  let scope: EventScope;

  const ingest = (
    visiteur: string,
    type: string,
    attributes: Record<string, unknown> = {},
    properties: Record<string, unknown> = {},
    occurredAt: string = OCCURRED_AT,
  ) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', visiteur)
      .send({ apiKey, type, occurredAt, attributes, properties })
      .expect(201);

  const page = (visiteur: string, path: string, occurredAt?: string) =>
    ingest(visiteur, 'page_view', { 'page.path': path }, {}, occurredAt);

  beforeAll(async () => {
    app = await createTestApp();

    db = app.get<DrizzleDatabase>(DRIZZLE);
    store = app.get(EventStore);

    const project = await createProject(db, {
      name: `e2e top-values ${new Date().toISOString()}`,
    });
    projectId = project.id;
    apiKey = project.apiKey;
    scope = { projectId, ...WINDOW };

    // /pricing : 3 événements, 2 visiteurs — le compte et l'audience diffèrent.
    await page('visiteur-a', '/pricing');
    await page('visiteur-a', '/pricing');
    await page('visiteur-b', '/pricing');
    // /docs : 2 événements, 2 visiteurs.
    await page('visiteur-a', '/docs');
    await page('visiteur-c', '/docs');
    // Deux valeurs à égalité, pour éprouver le départage.
    await page('visiteur-a', '/b');
    await page('visiteur-a', '/a');
    // Hors fenêtre, hors type, sans la clé, clé à `null`, valeur numérique.
    await page('visiteur-a', '/pricing', HORS_FENETRE);
    await ingest('visiteur-a', 'click', { 'page.path': '/pricing' });
    await ingest('visiteur-a', 'page_view');
    await ingest('visiteur-a', 'page_view', { 'page.path': null });
    await ingest('visiteur-a', 'page_view', { 'screen.width': 1512 });
  });

  afterAll(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(sessions).where(eq(sessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await app.close();
  });

  const pagesVues = (limit?: number) =>
    store.topValues(
      { ...scope, types: ['page_view'] },
      { source: 'attributes', key: 'page.path', limit },
    );

  describe('grouper', () => {
    it('compte les événements et les visiteurs de chaque valeur', async () => {
      expect(await pagesVues()).toEqual([
        { value: '/pricing', events: 3, visitors: 2 },
        { value: '/docs', events: 2, visitors: 2 },
        { value: '/a', events: 1, visitors: 1 },
        { value: '/b', events: 1, visitors: 1 },
      ]);
    });

    it('départage les égalités par la valeur, donc de façon déterministe', async () => {
      // `/a` et `/b` ont le même compte : sans second critère, Postgres serait
      // libre de les rendre dans n'importe quel ordre, et c'est la coupe du
      // `limit` qui deviendrait instable.
      const [premier, second] = await Promise.all([pagesVues(3), pagesVues(3)]);

      expect(premier.map((row) => row.value)).toEqual([
        '/pricing',
        '/docs',
        '/a',
      ]);
      expect(second).toEqual(premier);
    });

    it('groupe aussi une clé de properties', async () => {
      // Un module de suivi d'erreurs poserait exactement la même question, sur
      // une autre colonne et un autre vocabulaire — sans que le Core change.
      await ingest('visiteur-a', 'error', {}, { 'error.name': 'TypeError' });
      await ingest('visiteur-b', 'error', {}, { 'error.name': 'TypeError' });
      await ingest('visiteur-a', 'error', {}, { 'error.name': 'RangeError' });

      expect(
        await store.topValues(
          { ...scope, types: ['error'] },
          { source: 'properties', key: 'error.name' },
        ),
      ).toEqual([
        { value: 'TypeError', events: 2, visitors: 2 },
        { value: 'RangeError', events: 1, visitors: 1 },
      ]);
    });

    it('rend une valeur numérique sous sa forme textuelle', async () => {
      // `->>` rend du texte quel que soit le type JSON. Le Core ne connaît pas
      // le type attendu, donc il n'en invente pas.
      expect(
        await store.topValues(
          { ...scope, types: ['page_view'] },
          { source: 'attributes', key: 'screen.width' },
        ),
      ).toEqual([{ value: '1512', events: 1, visitors: 1 }]);
    });
  });

  describe('écarter', () => {
    it('ignore les événements où la clé est absente ou vaut null', async () => {
      const total = (await pagesVues(50)).reduce(
        (somme, row) => somme + row.events,
        0,
      );
      const tousLesPageView = await store.countEvents({
        ...scope,
        types: ['page_view'],
      });

      // 7 événements portent un chemin, 3 `page_view` n'en portent pas
      // (absent, `null`, autre clé). L'écart est la couverture, et il se lit
      // en comparant à `countEvents` — c'est ce qui rend l'exclusion honnête.
      expect(total).toBe(7);
      expect(tousLesPageView).toBe(10);
    });

    it('respecte le type demandé', async () => {
      // Un `click` porte pourtant `/pricing` : sans le filtre, il gonflerait le
      // compte de la page.
      const tousTypes = await store.topValues(scope, {
        source: 'attributes',
        key: 'page.path',
      });

      expect(tousTypes[0]).toEqual({
        value: '/pricing',
        events: 4,
        visitors: 2,
      });
    });

    it('respecte la fenêtre, borne haute exclue', async () => {
      // Un `/pricing` de plus existe trois jours plus tard.
      const large = await store.topValues(
        {
          projectId,
          from: WINDOW.from,
          to: new Date('2026-08-26T00:00:00.000Z'),
          types: ['page_view'],
        },
        { source: 'attributes', key: 'page.path' },
      );

      expect(large[0]).toEqual({ value: '/pricing', events: 4, visitors: 2 });
    });

    it("ne voit rien d'un autre projet", async () => {
      const autre = await createProject(db, {
        name: `e2e top-values voisin ${new Date().toISOString()}`,
      });

      const resultat = await store.topValues(
        { ...scope, projectId: autre.id },
        { source: 'attributes', key: 'page.path' },
      );

      await db.delete(sessions).where(eq(sessions.projectId, autre.id));
      await db.delete(projects).where(eq(projects.id, autre.id));
      expect(resultat).toEqual([]);
    });
  });

  describe('borner', () => {
    it('coupe au limit demandé', async () => {
      expect(await pagesVues(2)).toHaveLength(2);
    });

    it('rend 10 valeurs par défaut', async () => {
      for (let i = 0; i < 12; i += 1) {
        await page('visiteur-limite', `/page-${String(i).padStart(2, '0')}`);
      }

      expect(await pagesVues()).toHaveLength(10);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'refuse un limit invalide (%s) au lieu de laisser Postgres échouer',
      async (limit) => {
        await expect(pagesVues(limit)).rejects.toThrow(RangeError);
      },
    );
  });

  describe('la clé est une donnée, pas du SQL', () => {
    it('traite une clé biscornue comme une clé qui n’existe pas', async () => {
      const resultat = await store.topValues(
        { ...scope, types: ['page_view'] },
        {
          source: 'attributes',
          key: "page.path'); drop table events; --",
        },
      );

      expect(resultat).toEqual([]);
      // La table est toujours là, et pleine : la clé est partie en paramètre
      // lié, elle n'a jamais été du SQL.
      expect(
        await store.countEvents({ ...scope, types: ['page_view'] }),
      ).toBeGreaterThan(0);
    });

    it('accepte une clé qui n’a jamais été émise', async () => {
      expect(
        await store.topValues(scope, {
          source: 'properties',
          key: 'clé.jamais.vue',
        }),
      ).toEqual([]);
    });
  });
});

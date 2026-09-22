import {
  analyticsSummarySchema,
  cohortsPageSchema,
  eventsPageSchema,
  locationsPageSchema,
  movementsPageSchema,
  revenueAttributionPageSchema,
  revenueSeriesPageSchema,
  sessionsPageSchema,
  technologyPageSchema,
} from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import {
  cleanupFixtures,
  createProject,
  expectMatchesContract,
  joinOrganization,
  organizationId,
  signUp,
  TEST_ORIGIN,
  type SignedUpUser,
  type TestProject,
} from './fixtures';
import { createTestApp } from './harness';

/**
 * Un projet qui n'a jamais branché Stripe — l'outil gratuit, le projet open
 * source — doit lire son tableau de bord comme les autres.
 *
 * Le revenu n'est pas un module qu'on active : ce sont des événements, et un
 * projet sans encaisseur en a simplement zéro. Rien ne demande donc
 * l'intégration pour répondre, et c'est ce que cette suite fige — une garde
 * « Stripe connecté ? » posée un jour sur une route de lecture casserait la
 * page entière de tous ces projets-là, pas une carte.
 *
 * Chaque route est celle que la page analytics appelle, avec les paramètres
 * qu'elle envoie.
 */

const FENETRE = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-09-01T00:00:00.000Z',
};

describe('tableau de bord sans Stripe (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projet: TestProject;
  let lecteur: SignedUpUser;

  const lire = async <T>(
    path: string,
    query: Record<string, string>,
    schema: Parameters<typeof expectMatchesContract<T>>[1],
  ) =>
    expectMatchesContract(
      (
        await request(app.getHttpServer())
          .get(`/v1/projects/${projet.id}${path}`)
          .set('Cookie', lecteur.cookies)
          .query(query)
          .expect(200)
      ).body,
      schema,
    );

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);

    projet = await createProject(db, { name: 'e2e sans Stripe' });
    lecteur = await signUp(app, 'Lecteur sans Stripe');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    // Du trafic, et rien d'autre : c'est le projet qui n'encaisse pas.
    for (const path of ['/', '/docs', '/docs/install']) {
      await request(app.getHttpServer())
        .post('/v1/events')
        .set('Origin', TEST_ORIGIN)
        .set('User-Agent', 'visiteur sans Stripe')
        .send({
          apiKey: projet.apiKey,
          type: 'page_view',
          occurredAt: '2026-08-10T12:00:00.000Z',
          attributes: { 'page.path': path },
          properties: {},
        })
        .expect(201);
    }
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  it('n’a aucune intégration', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/integrations`)
      .set('Cookie', lecteur.cookies)
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('acct_');
  });

  it('rend le trafic', async () => {
    const summary = await lire('/analytics', FENETRE, analyticsSummarySchema);

    expect(summary.pageViews).toBe(3);

    const sessions = await lire(
      '/analytics/sessions',
      FENETRE,
      sessionsPageSchema,
    );

    expect(sessions.sessions).toHaveLength(1);

    await lire(
      '/analytics/locations',
      { ...FENETRE, grain: 'country', limit: '250' },
      locationsPageSchema,
    );
    await lire(
      '/analytics/technology',
      { ...FENETRE, grain: 'browser', limit: '250' },
      technologyPageSchema,
    );
    await lire(
      '/events',
      { ...FENETRE, types: 'deployment' },
      eventsPageSchema,
    );
  });

  it('rend une attribution vide sur tous les axes de la page', async () => {
    const page = await lire(
      '/revenue/attribution',
      {
        ...FENETRE,
        axes: 'source,campaign,referrer,landing,browser,os,device,country',
        limit: '10',
      },
      revenueAttributionPageSchema,
    );

    for (const axis of [
      page.source,
      page.campaign,
      page.referrer,
      page.landing,
      page.browser,
      page.os,
      page.device,
      page.country,
    ]) {
      expect(axis).toEqual({ rows: [], direct: [], unattributed: [] });
    }
  });

  it('rend une série de revenu vide', async () => {
    const series = await lire(
      '/revenue/series',
      { ...FENETRE, step: 'day' },
      revenueSeriesPageSchema,
    );

    expect(series.points).toEqual([]);
  });

  it('rend des cohortes et des mouvements vides', async () => {
    await lire('/revenue/cohorts', FENETRE, cohortsPageSchema);
    await lire('/revenue/movements', FENETRE, movementsPageSchema);
  });
});

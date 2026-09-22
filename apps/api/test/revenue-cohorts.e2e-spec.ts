import {
  cohortsPageSchema,
  movementsPageSchema,
} from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import { stripeCustomers, stripeSubscriptions } from '../src/database/schema';
import {
  TEST_ORIGIN,
  cleanupFixtures,
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
 * La matrice de rétention, de la visite consentie à la cellule.
 *
 * Ce qui ne s'éprouve qu'ici : la **traversée de la frontière**. La cohorte naît
 * d'une visite rangée dans `sessions` sous une clé que ce module n'a pas le
 * droit de nommer, et d'un abonnement rangé dans ses propres tables. Le
 * croisement passe par `CoreService.firstVisits`, qui dérive la clé depuis
 * l'identifiant brut — un test unitaire ne peut ni la dériver ni la comparer.
 */

const VISITEUR = 'b1d4f2a0-6c3e-4f77-9c22-2a1d8f5e0c31';
const SANS_VISITE = 'cus_ancien';

const PREMIERE_VISITE = '2026-03-05T10:00:00.000Z';

const FENETRE = {
  from: '2026-03-01T00:00:00.000Z',
  to: '2026-05-31T23:59:59.999Z',
  depth: '3',
};

const NAVIGATEUR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('cohortes de revenu (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projet: TestProject;
  let lecteur: SignedUpUser;
  const created: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);

    projet = await createProject(db, { name: 'e2e cohortes' });
    created.push(projet.id);

    lecteur = await signUp(app, 'Lecteur cohortes');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    // Une visite consentie, donc rangée sous l'identité durable : c'est elle qui
    // donnera sa cohorte au client. Le cookie est posé à la main pour que le
    // test choisisse l'identifiant plutôt que de le lire dans la réponse.
    await request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', NAVIGATEUR)
      .set('Cookie', `__Host-eh_vid=${VISITEUR}`)
      .send({
        apiKey: projet.apiKey,
        type: 'page_view',
        occurredAt: PREMIERE_VISITE,
        attributes: { 'page.path': '/' },
        properties: {},
        consent: true,
      })
      .expect(201);

    await db.insert(stripeCustomers).values({
      projectId: projet.id,
      customerId: 'cus_connu',
      visitorId: VISITEUR,
    });

    await db.insert(stripeSubscriptions).values([
      {
        projectId: projet.id,
        stripeId: 'sub_connu',
        customerId: 'cus_connu',
        status: 'active',
        currency: 'eur',
        createdAt: new Date(PREMIERE_VISITE),
        startDate: new Date('2026-03-06T10:00:00.000Z'),
        cancelAtPeriodEnd: false,
        endedAt: new Date('2026-04-20T00:00:00.000Z'),
        collectionMethod: 'charge_automatically',
        livemode: false,
        observedAt: new Date('2026-04-20T00:00:00.000Z'),
      },
      {
        // Abonné avant l'installation : aucune visite ne le porte.
        projectId: projet.id,
        stripeId: 'sub_ancien',
        customerId: SANS_VISITE,
        status: 'active',
        currency: 'eur',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        startDate: new Date('2025-01-01T00:00:00.000Z'),
        cancelAtPeriodEnd: false,
        endedAt: null,
        collectionMethod: 'charge_automatically',
        livemode: false,
        observedAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(stripeSubscriptions)
      .where(inArray(stripeSubscriptions.projectId, created));
    await db
      .delete(stripeCustomers)
      .where(inArray(stripeCustomers.projectId, created));
    await cleanupFixtures(db);
    await app.close();
  });

  const lire = async (query: Record<string, string> = {}) => {
    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/cohorts`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, ...query })
      .expect(200);

    return expectMatchesContract(response.body, cohortsPageSchema);
  };

  it('range le client dans le mois de sa première visite', async () => {
    const page = await lire();

    // La clé n'a jamais franchi le fil : ce que le module a passé au socle est
    // l'identifiant brut du cookie, et ce qu'il en a reçu est une date.
    expect(page.cohorts).toEqual([
      expect.objectContaining({
        month: '2026-03',
        customers: 1,
        converted: 1,
        // Actif à la clôture de mars seulement : il part le 20 avril, donc il
        // n'est plus là quand avril se ferme, le 1er mai. La cellule dit « à la
        // clôture », pas « pendant ».
        active: [1, 0, 0, 0],
      }),
      expect.objectContaining({ month: '2026-04', customers: 0 }),
      expect.objectContaining({ month: '2026-05', customers: 0 }),
    ]);
  });

  it('compte à part l’abonné dont aucune visite n’est connue', async () => {
    const page = await lire();

    // Le client d'avant l'installation. Le répartir dans une cohorte fausserait
    // toutes celles qui l'entourent ; le taire ferait passer une matrice
    // partielle pour une matrice complète.
    expect(page.unmeasured).toBe(1);
  });

  it('ne mesure pas un mois qui n’est pas écoulé', async () => {
    const page = await lire({
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      depth: '2',
    });

    // Le mois courant n'est pas clos : `null` et non zéro, sans quoi la matrice
    // montrerait une falaise sur son bord le plus récent.
    expect(page.cohorts).toHaveLength(1);
    expect(page.cohorts[0].active).toEqual([null, null, null]);
  });

  it('refuse un paramètre qu’il n’applique pas', async () => {
    await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/cohorts`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, grain: 'week' })
      .expect(400);
  });

  describe('les mouvements', () => {
    const mouvements = async (query: Record<string, string> = {}) => {
      const response = await request(app.getHttpServer())
        .get(`/v1/projects/${projet.id}/revenue/movements`)
        .set('Cookie', lecteur.cookies)
        .query({ from: FENETRE.from, to: FENETRE.to, ...query })
        .expect(200);

      return expectMatchesContract(response.body, movementsPageSchema);
    };

    it('compte les entrées, les sorties et le solde de chaque mois', async () => {
      const page = await mouvements();

      // L'abonné d'avant l'installation compte ici, lui : le churn se lit dans
      // les dates, pas dans les visites. C'est la différence avec les cohortes,
      // d'où il est absent faute de première visite connue.
      expect(page.movements).toEqual([
        { month: '2026-03', started: 1, ended: 0, active: 2 },
        { month: '2026-04', started: 0, ended: 1, active: 1 },
        { month: '2026-05', started: 0, ended: 0, active: 1 },
      ]);
    });

    it('ne rend pas le mois en cours', async () => {
      const page = await mouvements({ to: new Date().toISOString() });
      const courant = `${String(new Date().getUTCFullYear())}-${String(
        new Date().getUTCMonth() + 1,
      ).padStart(2, '0')}`;

      expect(page.movements.map((mois) => mois.month)).not.toContain(courant);
    });
  });
});

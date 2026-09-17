import {
  revenueAttributionPageSchema,
  revenueSeriesPageSchema,
} from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CoreService } from '../src/core/core.service';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import {
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
 * Le revenu dans le temps, et la propriété qui justifie cette route.
 *
 * Elle existe pour que le calcul ne soit pas refait dans chaque page — donc le
 * seul test qui compte vraiment est celui qui **compare son total à celui de
 * l'attribution** sur la même fenêtre. S'ils divergent un jour, c'est
 * exactement la panne que centraliser devait empêcher.
 *
 * Le reste éprouve ce qu'un double rendrait vert à tort : le `date_trunc` qui
 * regroupe, la séparation des devises, et le fait qu'un pas sans paiement soit
 * **absent** plutôt qu'à zéro.
 */

const FENETRE = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-09-01T00:00:00.000Z',
};

/** La devise du compte connecté : celle dans laquelle tout est réglé. */
const REGLEMENT = 'eur';

/** Le taux que « Stripe » aurait appliqué. Recopié, jamais recalculé. */
const TAUX = 0.92;

const NOUVEAU = 'stripe.subscription.started';
const RENOUVELLEMENT = 'stripe.subscription.renewed';

describe('série de revenu (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let core: CoreService;
  let projet: TestProject;
  let lecteur: SignedUpUser;

  /**
   * Le **règlement** est écrit à côté du montant facturé : c'est lui que la
   * série somme, comme l'attribution, et c'est la condition pour que les deux
   * lectures rendent le même total.
   */
  const encaisser = (
    type: string,
    amount: number,
    currency: string,
    occurredAt: string,
  ) =>
    core.ingest({
      projectId: projet.id,
      type,
      occurredAt: new Date(occurredAt),
      attributes: {},
      properties: {
        'payment.amount': amount,
        'payment.currency': currency,
        'payment.settled':
          currency === REGLEMENT ? amount : Math.round(amount * TAUX),
        'payment.settled_currency': REGLEMENT,
        'payment.exchange_rate': currency === REGLEMENT ? null : TAUX,
      },
      source: 'server',
    });

  const lire = async (query: Record<string, string> = {}) =>
    expectMatchesContract(
      (
        await request(app.getHttpServer())
          .get(`/v1/projects/${projet.id}/revenue/series`)
          .set('Cookie', lecteur.cookies)
          .query({ ...FENETRE, ...query })
          .expect(200)
      ).body,
      revenueSeriesPageSchema,
    );

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    core = app.get(CoreService);

    projet = await createProject(db, { name: 'e2e série de revenu' });
    lecteur = await signUp(app, 'Lecteur série');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    // Deux paiements le même jour, à deux heures différentes : ils doivent
    // tomber dans le même pas.
    await encaisser(NOUVEAU, 2000, 'eur', '2026-08-03T09:00:00.000Z');
    await encaisser(RENOUVELLEMENT, 500, 'eur', '2026-08-03T21:00:00.000Z');
    // Une autre devise, le même jour : elle rejoint le même point, parce que
    // c'est le règlement qui est sommé et qu'il est dans une seule devise.
    await encaisser(NOUVEAU, 1500, 'usd', '2026-08-03T10:00:00.000Z');
    // Un mois plus loin dans la fenêtre, pour que `week` et `month` regroupent.
    await encaisser(NOUVEAU, 700, 'eur', '2026-08-20T12:00:00.000Z');
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  it('regroupe les paiements d’un même jour, dans la devise du règlement', async () => {
    const page = await lire();

    // 2000 + 500 encaissés en euros, 1500 en dollars réglés 1380 : un seul
    // point. Rien n'est converti ici — le montant réglé est celui que Stripe a
    // écrit sur sa transaction de solde.
    expect(page.points).toEqual([
      expect.objectContaining({
        start: '2026-08-03T00:00:00.000Z',
        currency: 'eur',
        amount: 3880,
        payments: 3,
      }),
      expect.objectContaining({
        start: '2026-08-20T00:00:00.000Z',
        currency: 'eur',
        amount: 700,
      }),
    ]);
  });

  it('ne comble pas les pas vides', async () => {
    const page = await lire();

    // Trente et un jours dans la fenêtre, deux points. Un jour sans paiement
    // n'est pas à zéro : il est absent, et c'est au lecteur de compléter son
    // axe — il est le seul à savoir quelles bornes il affiche.
    expect(page.points).toHaveLength(2);
  });

  it('change de pas sans changer le total', async () => {
    const somme = (points: { currency: string | null; amount: number }[]) =>
      points
        .filter((point) => point.currency === 'eur')
        .reduce((total, point) => total + point.amount, 0);

    const [jour, semaine, mois] = await Promise.all([
      lire(),
      lire({ step: 'week' }),
      lire({ step: 'month' }),
    ]);

    // Moins de points à mesure que le pas grossit, et la même somme : c'est ce
    // qui prouve que le regroupement regroupe au lieu de perdre.
    expect(mois.points.length).toBeLessThan(jour.points.length);
    expect(somme(semaine.points)).toBe(4580);
    expect(somme(mois.points)).toBe(4580);
    expect(somme(jour.points)).toBe(4580);
  });

  it('rend le même total que l’attribution, devise par devise', async () => {
    // **Le test qui justifie cette route.** Elle existe pour que le calcul ne
    // soit pas refait dans chaque page ; si les deux lectures divergent, c'est
    // précisément la panne que centraliser devait empêcher.
    const attribution = expectMatchesContract(
      (
        await request(app.getHttpServer())
          .get(`/v1/projects/${projet.id}/revenue/attribution`)
          .set('Cookie', lecteur.cookies)
          .query(FENETRE)
          .expect(200)
      ).body,
      revenueAttributionPageSchema,
    );

    const parDevise = (
      rows: { currency: string | null; amount: number }[],
    ): Record<string, number> => {
      const totals: Record<string, number> = {};

      for (const row of rows) {
        const key = String(row.currency);

        totals[key] = (totals[key] ?? 0) + row.amount;
      }

      return totals;
    };

    const campaign = attribution.campaign;

    if (!campaign) throw new Error('L’axe campagne devrait être rendu.');

    expect(parDevise((await lire()).points)).toEqual(
      parDevise([
        ...campaign.rows,
        ...campaign.direct,
        ...campaign.unattributed,
      ]),
    );
  });

  it('refuse un pas qu’il ne connaît pas', async () => {
    await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/series`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, step: 'quarter' })
      .expect(400);
  });
});

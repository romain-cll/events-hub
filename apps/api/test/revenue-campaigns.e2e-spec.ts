import { campaignRevenuePageSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CoreService } from '../src/core/core.service';
import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import {
  TEST_ORIGIN,
  cleanupFixtures,
  cookiesOf,
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
 * Le revenu croisé à l'acquisition, de la visite au paiement.
 *
 * Ce que seul un vrai Postgres peut montrer ici : le `left join lateral` qui
 * remonte à la **première** visite du visiteur, sans borne de fenêtre. Les trois
 * propriétés éprouvées sont celles qu'un double rendrait vertes à tort —
 * l'acquisition qui déborde la fenêtre, la séparation des devises, et le fait
 * qu'un paiement sans parcours n'est pas rangé sous « direct ».
 *
 * Les paiements sont ingérés par le Core, pas par HTTP : `POST /v1/events` ne
 * permet pas de désigner un visiteur depuis une source serveur — l'identité y
 * vient du cookie. Le chemin testé reste le vrai, c'est exactement l'appel que
 * `features/stripe` fait en traitant un webhook.
 */

const PREMIERE_VISITE = new Date('2026-07-01T10:00:00.000Z');
const SECONDE_VISITE = new Date('2026-07-01T14:00:00.000Z');

/** La fenêtre de lecture : elle ne contient que les paiements. */
const FENETRE = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-09-01T00:00:00.000Z',
};

const PAIEMENT = new Date('2026-08-10T12:00:00.000Z');

const NAVIGATEUR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const COOKIE = '__Host-eh_vid';

const NOUVEAU = 'stripe.subscription.started';
const RENOUVELLEMENT = 'stripe.subscription.renewed';

describe('revenu par campagne (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let core: CoreService;
  let projet: TestProject;
  let lecteur: SignedUpUser;

  /** Une visite consentie ; rend l'identifiant durable que le hub a posé. */
  const visiter = async (
    occurredAt: Date,
    campaign?: Record<string, string>,
    visitorId?: string,
  ): Promise<string> => {
    const envoi = request(app.getHttpServer())
      .post('/v1/events')
      .set('Origin', TEST_ORIGIN)
      .set('User-Agent', NAVIGATEUR);

    if (visitorId) envoi.set('Cookie', `${COOKIE}=${visitorId}`);

    const response = await envoi
      .send({
        apiKey: projet.apiKey,
        type: 'page_view',
        occurredAt: occurredAt.toISOString(),
        attributes: { 'page.path': '/' },
        properties: {},
        consent: true,
        ...(campaign ? { campaign } : {}),
      })
      .expect(201);

    const pose = cookiesOf(response).find((value) => value.startsWith(COOKIE));

    return visitorId ?? /=([^;]+)/.exec(pose ?? '')?.[1] ?? '';
  };

  /** Un paiement rapporté par un serveur, comme `features/stripe` le fait. */
  const encaisser = (
    type: string,
    amount: number,
    currency: string,
    visitorId?: string,
  ) =>
    core.ingest({
      projectId: projet.id,
      type,
      occurredAt: PAIEMENT,
      attributes: {},
      properties: { 'payment.amount': amount, 'payment.currency': currency },
      source: 'server',
      visitorId,
    });

  const lire = async (query: Record<string, string> = {}) =>
    expectMatchesContract(
      (
        await request(app.getHttpServer())
          .get(`/v1/projects/${projet.id}/revenue/campaigns`)
          .set('Cookie', lecteur.cookies)
          .query({ ...FENETRE, ...query })
          .expect(200)
      ).body,
      campaignRevenuePageSchema,
    );

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    core = app.get(CoreService);

    projet = await createProject(db, { name: 'e2e revenu campagnes' });

    lecteur = await signUp(app, 'Lecteur revenu');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    // Deux visites du même visiteur, deux campagnes, et c'est la première qui
    // doit gagner : quatre heures les séparent, donc deux sessions.
    const avecCampagne = await visiter(PREMIERE_VISITE, {
      source: 'google',
      medium: 'cpc',
      name: 'rentree',
    });
    await visiter(
      SECONDE_VISITE,
      { source: 'bing', medium: 'organic' },
      avecCampagne,
    );

    // Un visiteur connu, venu sans campagne.
    const direct = await visiter(PREMIERE_VISITE);

    await encaisser(NOUVEAU, 2000, 'eur', avecCampagne);
    await encaisser(NOUVEAU, 1500, 'usd', avecCampagne);
    await encaisser(RENOUVELLEMENT, 900, 'eur', avecCampagne);
    await encaisser(NOUVEAU, 500, 'eur', direct);

    // Un visiteur qu'aucune visite ne porte : identifiant connu de Stripe,
    // jamais vu ici — le client d'avant l'installation.
    await encaisser(NOUVEAU, 700, 'eur', 'inconnu-au-bataillon');
    // Et un paiement sans identité du tout : consentement refusé.
    await encaisser(NOUVEAU, 300, 'eur');
  });

  afterAll(async () => {
    await cleanupFixtures(db);
    await app.close();
  });

  it('range le paiement sous la campagne de la première visite', async () => {
    const page = await lire();

    // `bing` est la seconde visite du même visiteur : elle ne doit apparaître
    // nulle part. L'acquisition est antérieure à la fenêtre, et c'est le point
    // — la fenêtre choisit les paiements, pas l'ancienneté qu'on leur reconnaît.
    expect(page.campaigns).toEqual([
      expect.objectContaining({
        campaign: { source: 'google', medium: 'cpc', name: 'rentree' },
        currency: 'eur',
        amount: 2000,
        payments: 1,
        visitors: 1,
      }),
      expect.objectContaining({
        campaign: { source: 'google', medium: 'cpc', name: 'rentree' },
        currency: 'usd',
        amount: 1500,
      }),
    ]);
  });

  it('ne mélange jamais deux devises dans un total', async () => {
    const page = await lire();

    // Deux lignes pour une seule campagne : 2000 + 1500 n'a pas de sens sans
    // taux de change, et la seule façon honnête de le dire est de ne pas le
    // faire.
    expect(page.campaigns.map((row) => row.currency)).toEqual(['eur', 'usd']);
  });

  it('sépare le visiteur connu sans campagne du paiement sans parcours', async () => {
    const page = await lire();

    // Connu, venu sans campagne : ce n'est pas un trou de mesure.
    expect(page.direct).toEqual([
      expect.objectContaining({ currency: 'eur', amount: 500, payments: 1 }),
    ]);

    // Deux paiements qu'aucune visite ne réclame — un client d'avant
    // l'installation, un refus de consentement. Les ranger dans `direct`
    // ferait passer un trou pour du trafic direct.
    expect(page.unattributed).toEqual([
      expect.objectContaining({ currency: 'eur', amount: 1000, payments: 2 }),
    ]);
  });

  it('nomme le type qu’il additionne, et n’additionne que celui-là', async () => {
    const page = await lire();

    expect(page.kind).toBe('new');
    expect(page.eventType).toBe(NOUVEAU);

    // Le renouvellement du même visiteur n'entre pas : il répond à une autre
    // question, et les deux ne s'additionnent pas.
    const eur = page.campaigns.find((row) => row.currency === 'eur');

    expect(eur?.amount).toBe(2000);
  });

  it('change de chiffre quand on change de question', async () => {
    const page = await lire({ kind: 'recurring' });

    expect(page.eventType).toBe(RENOUVELLEMENT);
    expect(page.campaigns).toEqual([
      expect.objectContaining({
        campaign: { source: 'google', medium: 'cpc', name: 'rentree' },
        currency: 'eur',
        amount: 900,
      }),
    ]);
    // Personne d'autre n'a renouvelé : les deux autres ensembles sont vides,
    // et vides veut dire « rien à attribuer », pas « rien à voir ».
    expect(page.direct).toEqual([]);
    expect(page.unattributed).toEqual([]);
  });

  it('refuse un paramètre qu’il n’applique pas', async () => {
    await request(app.getHttpServer())
      .get(`/v1/projects/${projet.id}/revenue/campaigns`)
      .set('Cookie', lecteur.cookies)
      .query({ ...FENETRE, interval: 'day' })
      .expect(400);
  });
});

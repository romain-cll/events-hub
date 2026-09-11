import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import request from 'supertest';
import type { App } from 'supertest/types';

import { DRIZZLE, type DrizzleDatabase } from '../src/database/database.module';
import {
  events,
  integrations,
  projects,
  sessions,
  stripeCustomers,
  stripeWebhookEvents,
} from '../src/database/schema';
import { VisitorKeyService } from '../src/privacy/visitor-key.service';
import { createProject, perRun, type TestProject } from './fixtures';
import { createTestApp } from './harness';

/**
 * Les webhooks Stripe, du corps signé jusqu'à l'événement écrit.
 *
 * Rien de ce qui compte ici n'est visible ailleurs : la vérification de
 * signature porte sur les **octets** reçus, donc elle ne tient que si
 * `express.raw` est monté avant le parsing JSON — un détail d'assemblage
 * qu'aucun test unitaire ne peut exercer. La déduplication, elle, s'arbitre dans
 * Postgres.
 *
 * Les secrets sont posés dans `process.env` avant la construction du module :
 * ils n'ont pas à exister dans le `.env` de qui fait tourner la suite, et de
 * fausses valeurs suffisent — la signature se vérifie hors ligne.
 */

const ACCOUNT = 'acct_e2e_test';
const WEBHOOK_SECRET = 'whsec_e2e_test';
const VISITOR_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const stripe = new Stripe('sk_test_e2e');

/** Un événement Stripe crédible, signé comme Stripe le signerait. */
function webhook(
  overrides: {
    id?: string;
    type?: string;
    account?: string;
    object?: Record<string, unknown>;
  } = {},
) {
  const payload = JSON.stringify({
    id: overrides.id ?? perRun('evt_e2e_1'),
    object: 'event',
    api_version: '2025-01-01',
    created: 1_788_000_000,
    livemode: false,
    type: overrides.type ?? 'invoice.paid',
    account: overrides.account ?? ACCOUNT,
    data: {
      object: overrides.object ?? {
        id: 'in_e2e_1',
        object: 'invoice',
        amount_paid: 4900,
        currency: 'eur',
        billing_reason: 'subscription_cycle',
        metadata: { eh_visitor_id: VISITOR_ID },
      },
    },
  });

  return {
    payload,
    signature: stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    }),
  };
}

describe('webhooks Stripe (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let visitorKeys: VisitorKeyService;
  let projet: TestProject;
  const created: string[] = [];
  /**
   * Les réservations à effacer : `stripe_webhook_events` n'est pas cloisonnée
   * par projet, rien ne part en cascade avec le projet supprimé.
   *
   * C'est un ménage, pas une protection — ce qui rend un résidu inoffensif est
   * `perRun`, parce que ce tableau ne s'exécute pas quand la suite meurt.
   */
  const seenEvents: string[] = [];

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_e2e';
    process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_e2e';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    visitorKeys = app.get(VisitorKeyService);

    projet = await createProject(db, { name: 'e2e stripe' });
    created.push(projet.id);

    await db.insert(integrations).values({
      projectId: projet.id,
      provider: 'stripe',
      externalAccountId: ACCOUNT,
      scope: 'read_only',
      livemode: false,
    });
  });

  afterAll(async () => {
    for (const id of seenEvents) {
      await db
        .delete(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.eventId, id));
    }
    for (const id of created) {
      await db.delete(stripeCustomers).where(eq(stripeCustomers.projectId, id));
      await db.delete(events).where(eq(events.projectId, id));
      await db.delete(sessions).where(eq(sessions.projectId, id));
      await db.delete(projects).where(eq(projects.id, id));
    }
    await app.close();
  });

  const post = ({ payload, signature }: ReturnType<typeof webhook>) =>
    request(app.getHttpServer())
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(payload);

  const ecrits = () =>
    db
      .select({
        type: events.type,
        source: events.source,
        sessionId: events.sessionId,
        visitorKey: events.visitorKey,
        properties: events.properties,
      })
      .from(events)
      .where(eq(events.projectId, projet.id));

  it('refuse un corps qui n’est pas signé par Stripe', async () => {
    const { payload } = webhook({ id: perRun('evt_e2e_faux') });

    await request(app.getHttpServer())
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send(payload)
      .expect(400);

    // C'est le seul rempart de cette route : sans lui, n'importe qui fabrique
    // du revenu dans le projet d'un client.
    expect(await ecrits()).toHaveLength(0);
  });

  it('écrit un renouvellement, relié à son visiteur et sans visite', async () => {
    seenEvents.push(perRun('evt_e2e_1'));

    await post(webhook()).expect(200);

    const [event] = await ecrits();

    expect(event.type).toBe('stripe.subscription.renewed');
    expect(event.source).toBe('server');
    // Le cœur du lot : un visiteur, et pas de visite.
    expect(event.sessionId).toBeNull();
    expect(event.visitorKey).toBe(
      visitorKeys.computeStable(projet.id, VISITOR_ID),
    );
    expect(event.properties).toMatchObject({
      'payment.amount': 4900,
      'stripe.event.id': perRun('evt_e2e_1'),
    });
  });

  it('ne réécrit rien quand Stripe rejoue le même événement', async () => {
    await post(webhook()).expect(200);

    // Stripe rejoue sur timeout, sur 5xx, et par prudence. Sans déduplication le
    // revenu du jour double, et rien ne le signale — la donnée reste plausible.
    expect(await ecrits()).toHaveLength(1);
  });

  it('ignore un compte branché sur aucun projet, sans faire échouer Stripe', async () => {
    seenEvents.push(perRun('evt_e2e_inconnu'));

    // Répondre 4xx ferait rejouer Stripe indéfiniment pour un événement qu'on a
    // délibérément écarté.
    await post(
      webhook({ id: perRun('evt_e2e_inconnu'), account: 'acct_jamais_vu' }),
    ).expect(200);

    expect(await ecrits()).toHaveLength(1);
  });

  it('laisse passer un type Stripe qu’on n’interprète pas', async () => {
    seenEvents.push(perRun('evt_e2e_inconnu_type'));

    await post(
      webhook({
        id: perRun('evt_e2e_inconnu_type'),
        type: 'charge.dispute.funds_withdrawn',
        object: { id: 'dp_1', amount: 4900, currency: 'eur' },
      }),
    ).expect(200);

    const types = (await ecrits()).map((row) => row.type);

    expect(types).toContain('stripe.charge.dispute.funds_withdrawn');
  });

  it('écrit un paiement sans metadata, mais sans visiteur', async () => {
    seenEvents.push(perRun('evt_e2e_anonyme'));

    // Pas de consentement, pas d'`eh_visitor_id`. Le paiement reste du revenu ;
    // il n'est rattaché à aucun parcours, et c'est le cadre qui le veut.
    await post(
      webhook({
        id: perRun('evt_e2e_anonyme'),
        object: {
          id: 'in_e2e_2',
          amount_paid: 1900,
          currency: 'eur',
          billing_reason: 'subscription_create',
        },
      }),
    ).expect(200);

    const anonyme = (await ecrits()).find(
      (row) => row.properties['stripe.event.id'] === perRun('evt_e2e_anonyme'),
    );

    expect(anonyme?.type).toBe('stripe.subscription.started');
    expect(anonyme?.visitorKey).toBeNull();
  });
});

/**
 * L'attribution rétroactive, et la course qu'elle répare.
 *
 * C'est le scénario qui a échoué en conditions réelles avant d'exister ici : sur
 * un abonnement pris avec l'intégration complète, deux événements sur douze
 * étaient attribués. Le site pose l'identifiant sur son client *après* le
 * checkout, les webhooks du paiement arrivent avant, et c'est le paiement — le
 * seul qui compte — qui repartait muet.
 *
 * Une suite à part parce qu'elle a besoin d'un projet vierge : elle compte des
 * événements attribués, et ceux de la suite précédente fausseraient le compte.
 */
describe('attribution rétroactive (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let visitorKeys: VisitorKeyService;
  let projet: TestProject;
  const created: string[] = [];

  const CUSTOMER = 'cus_e2e_course';

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_e2e';
    process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_e2e';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    app = await createTestApp();
    db = app.get<DrizzleDatabase>(DRIZZLE);
    visitorKeys = app.get(VisitorKeyService);

    projet = await createProject(db, { name: 'e2e stripe rétroactif' });
    created.push(projet.id);

    await db.insert(integrations).values({
      projectId: projet.id,
      provider: 'stripe',
      externalAccountId: ACCOUNT,
      scope: 'read_only',
      livemode: false,
    });
  });

  afterAll(async () => {
    for (const id of created) {
      await db.delete(stripeCustomers).where(eq(stripeCustomers.projectId, id));
      await db.delete(events).where(eq(events.projectId, id));
      await db.delete(sessions).where(eq(sessions.projectId, id));
      await db.delete(projects).where(eq(projects.id, id));
    }
    await app.close();
  });

  const post = ({ payload, signature }: ReturnType<typeof webhook>) =>
    request(app.getHttpServer())
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(payload);

  const attribues = async () => {
    const rows = await db
      .select({ type: events.type, visitorKey: events.visitorKey })
      .from(events)
      .where(eq(events.projectId, projet.id));

    return rows;
  };

  it('écrit le paiement sans visiteur, puis le rattrape', async () => {
    // 1. Le paiement arrive le premier, sans metadata — le site n'a pas encore
    //    posé l'identifiant sur son client.
    await post(
      webhook({
        id: perRun('evt_e2e_course_paiement'),
        type: 'invoice.paid',
        object: {
          id: 'in_e2e_course',
          object: 'invoice',
          customer: CUSTOMER,
          amount_paid: 4900,
          currency: 'eur',
          billing_reason: 'subscription_create',
        },
      }),
    ).expect(200);

    const avant = await attribues();

    expect(avant).toHaveLength(1);
    expect(avant[0].type).toBe('stripe.subscription.started');
    expect(avant[0].visitorKey).toBeNull();

    // 2. Deux secondes plus tard, le site pose l'identifiant sur le client.
    await post(
      webhook({
        id: perRun('evt_e2e_course_client'),
        type: 'customer.updated',
        object: {
          id: CUSTOMER,
          object: 'customer',
          metadata: { eh_visitor_id: VISITOR_ID },
        },
      }),
    ).expect(200);

    // 3. Le paiement est rattaché, sans avoir été rejoué.
    const apres = await attribues();
    const attendue = visitorKeys.computeStable(projet.id, VISITOR_ID);
    const paiement = apres.find(
      (row) => row.type === 'stripe.subscription.started',
    );

    expect(paiement?.visitorKey).toBe(attendue);
    // Et le `customer.updated` lui-même l'est aussi, par sa propre metadata.
    expect(
      apres.find((row) => row.type === 'stripe.customer.updated')?.visitorKey,
    ).toBe(attendue);
  });

  it('attribue directement ce qui arrive après, sans réinterroger Stripe', async () => {
    // La paire est retenue : un renouvellement sans metadata propre — le cas
    // qui porte la LTV — est attribué par son client.
    await post(
      webhook({
        id: perRun('evt_e2e_course_renouvellement'),
        type: 'invoice.paid',
        object: {
          id: 'in_e2e_course_2',
          object: 'invoice',
          customer: CUSTOMER,
          amount_paid: 4900,
          currency: 'eur',
          billing_reason: 'subscription_cycle',
        },
      }),
    ).expect(200);

    const renouvellement = (await attribues()).find(
      (row) => row.type === 'stripe.subscription.renewed',
    );

    expect(renouvellement?.visitorKey).toBe(
      visitorKeys.computeStable(projet.id, VISITOR_ID),
    );
  });
});

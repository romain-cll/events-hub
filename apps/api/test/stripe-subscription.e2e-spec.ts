import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
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
  stripeSubscriptionItems,
  stripeSubscriptions,
  stripeWebhookEvents,
} from '../src/database/schema';
import { createProject, perRun, type TestProject } from './fixtures';
import { createTestApp } from './harness';

/**
 * La projection de l'état d'abonnement, du webhook à la table.
 *
 * Deux propriétés ne s'éprouvent qu'ici, contre un vrai Postgres :
 *
 * - **le garde-fou d'ordre**. Stripe ne garantit pas l'ordre de livraison, et
 *   c'est un `setWhere` sur l'upsert qui empêche un `.updated` en retard de
 *   ressusciter un abonnement résilié. Un double de Drizzle ne l'exécuterait
 *   pas ;
 * - **le remplacement des items**, qui est une suppression suivie d'une
 *   insertion dans la même transaction. Un downgrade doit faire disparaître une
 *   ligne, pas la laisser avec son ancien montant.
 */

const ACCOUNT = 'acct_e2e_abo';
const WEBHOOK_SECRET = 'whsec_e2e_abo';
const T0 = 1_788_100_000;

const stripe = new Stripe('sk_test_e2e');

/** Une ligne d'abonnement, réduite à ce que la projection lit. */
function item(
  id: string,
  priceId: string,
  unitAmount: number | null,
  quantity = 1,
) {
  return {
    id,
    object: 'subscription_item',
    quantity,
    current_period_start: T0,
    current_period_end: T0 + 2_592_000,
    price: {
      id: priceId,
      object: 'price',
      product: 'prod_e2e',
      currency: 'eur',
      unit_amount: unitAmount,
      recurring: { interval: 'month', interval_count: 1 },
    },
  };
}

function abonnement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_e2e',
    object: 'subscription',
    customer: 'cus_e2e',
    status: 'active',
    currency: 'eur',
    created: T0,
    start_date: T0,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    collection_method: 'charge_automatically',
    livemode: false,
    items: { object: 'list', data: [item('si_e2e_1', 'price_socle', 1900)] },
    ...overrides,
  };
}

function webhook({
  id,
  type = 'customer.subscription.updated',
  created = T0 + 60,
  object,
}: {
  id: string;
  type?: string;
  created?: number;
  object: Record<string, unknown>;
}) {
  const payload = JSON.stringify({
    id,
    object: 'event',
    api_version: '2025-01-01',
    created,
    livemode: false,
    type,
    account: ACCOUNT,
    data: { object },
  });

  return {
    payload,
    signature: stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    }),
  };
}

describe('projection d’abonnement (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let projet: TestProject;
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

    projet = await createProject(db, { name: 'e2e abonnements' });

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
    // Les items partent en cascade avec leur abonnement.
    await db
      .delete(stripeSubscriptions)
      .where(eq(stripeSubscriptions.projectId, projet.id));
    await db
      .delete(stripeCustomers)
      .where(eq(stripeCustomers.projectId, projet.id));
    await db.delete(events).where(eq(events.projectId, projet.id));
    await db.delete(sessions).where(eq(sessions.projectId, projet.id));
    await db.delete(projects).where(eq(projects.id, projet.id));
    await app.close();
  });

  const post = (parametres: Parameters<typeof webhook>[0]) => {
    seenEvents.push(parametres.id);

    const { payload, signature } = webhook(parametres);

    return request(app.getHttpServer())
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(payload);
  };

  const abonnements = () =>
    db
      .select()
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.projectId, projet.id));

  const lignes = async (subscriptionId: string) =>
    db
      .select()
      .from(stripeSubscriptionItems)
      .where(eq(stripeSubscriptionItems.subscriptionId, subscriptionId))
      .orderBy(asc(stripeSubscriptionItems.stripeId));

  it('range l’abonnement et sa ligne à la création', async () => {
    await post({
      id: perRun('evt_abo_1'),
      type: 'customer.subscription.created',
      object: abonnement(),
    }).expect(200);

    const [abo] = await abonnements();

    expect(abo).toMatchObject({
      stripeId: 'sub_e2e',
      customerId: 'cus_e2e',
      status: 'active',
      currency: 'eur',
      cancelAtPeriodEnd: false,
      endedAt: null,
      observedAt: new Date((T0 + 60) * 1000),
    });

    expect(await lignes(abo.id)).toMatchObject([
      { stripeId: 'si_e2e_1', priceId: 'price_socle', unitAmount: 1900 },
    ]);
  });

  it('remplace les lignes plutôt que de les fusionner', async () => {
    await post({
      id: perRun('evt_abo_2'),
      created: T0 + 120,
      object: abonnement({
        items: {
          object: 'list',
          data: [
            item('si_e2e_2', 'price_pro', 4900, 3),
            item('si_e2e_3', 'price_module', 900),
          ],
        },
      }),
    }).expect(200);

    const [abo] = await abonnements();
    const items = await lignes(abo.id);

    // L'ancienne ligne a **disparu**. La laisser avec son montant ferait un
    // total d'abonnement resté à l'ancien plan, sans que rien n'échoue.
    expect(items.map((ligne) => ligne.stripeId)).toEqual([
      'si_e2e_2',
      'si_e2e_3',
    ]);
    expect(items[0]).toMatchObject({ unitAmount: 4900, quantity: 3 });
  });

  it('n’applique pas une observation plus ancienne que celle en base', async () => {
    // Le cas qui justifie la colonne `observedAt` : un `.updated` livré en
    // retard, porteur d'un état antérieur. Sans le garde-fou, l'abonnement
    // repasserait au plan d'avant et rien ne le signalerait.
    await post({
      id: perRun('evt_abo_perime'),
      created: T0 + 30,
      object: abonnement({ status: 'past_due' }),
    }).expect(200);

    const [abo] = await abonnements();

    expect(abo.status).toBe('active');
    expect(abo.observedAt).toEqual(new Date((T0 + 120) * 1000));
    // Les lignes non plus n'ont pas été remplacées : une observation périmée ne
    // rend aucune ligne, donc le remplacement n'a pas lieu.
    expect(await lignes(abo.id)).toHaveLength(2);
  });

  it('résilie sans supprimer la ligne', async () => {
    await post({
      id: perRun('evt_abo_fin'),
      type: 'customer.subscription.deleted',
      created: T0 + 300,
      object: abonnement({
        status: 'canceled',
        canceled_at: T0 + 200,
        ended_at: T0 + 2_592_000,
      }),
    }).expect(200);

    const [abo] = await abonnements();

    // La ligne résiliée *est* ce dont une lecture de churn a besoin. Et les deux
    // dates sont distinctes : la demande précède la fin d'une période entière.
    expect(abo).toMatchObject({
      status: 'canceled',
      canceledAt: new Date((T0 + 200) * 1000),
      endedAt: new Date((T0 + 2_592_000) * 1000),
    });
    expect(await abonnements()).toHaveLength(1);
  });

  it('écrit l’événement même quand il n’y a rien à projeter', async () => {
    // La projection vit dans le bloc « après l'écriture », donc elle ne peut pas
    // faire relâcher la réservation : un abonnement sans client ne se projette
    // pas, mais son événement est écrit comme les autres.
    await post({
      id: perRun('evt_abo_sans_client'),
      created: T0 + 400,
      object: abonnement({ id: 'sub_orphelin', customer: null }),
    }).expect(200);

    const ecrits = await db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.projectId, projet.id));

    expect(ecrits).toContainEqual({
      type: 'stripe.customer.subscription.updated',
    });
    expect(await abonnements()).toHaveLength(1);
  });
});

import { syncReportSchema } from '@events-hub/api-contract';
import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CoreService } from '../src/core/core.service';
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
  users,
} from '../src/database/schema';
import { StripeConnectService } from '../src/integrations/stripe-connect.service';
import { VisitorKeyService } from '../src/privacy/visitor-key.service';
import {
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
 * Le rattrapage d'historique, du bouton jusqu'aux trois tables.
 *
 * Le client Stripe est doublé — c'est la seule façon d'éprouver une lecture
 * sortante — mais **rien d'autre ne l'est** : la route, le guard, les
 * réservations, l'attribution rétroactive et la projection sont les vrais.
 *
 * Ce qui se joue ici et nulle part ailleurs :
 *
 * - une paire client ↔ visiteur apprise **après coup** rattache du revenu déjà
 *   écrit, ce qui est la seule réparation possible d'un client antérieur à
 *   l'installation ;
 * - la borne `created < connectedAt` sur les factures, sans laquelle le rejeu
 *   doublerait ce que les webhooks ont déjà écrit ;
 * - l'idempotence : relancer ne réécrit rien.
 */

const ACCOUNT = 'acct_e2e_sync';
const VISITEUR = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const T0 = 1_788_200_000;

/** Ce que `autoPagingEach` attend, réduit à ce que le service en appelle. */
function pages<T>(items: T[]) {
  return {
    autoPagingEach: async (visite: (item: T) => unknown) => {
      for (const item of items) await visite(item);
    },
  };
}

function client(id: string, visitorId?: string) {
  return {
    id,
    object: 'customer',
    metadata: visitorId ? { eh_visitor_id: visitorId } : {},
  };
}

function abonnement(id: string, hasMore = false) {
  return {
    id,
    object: 'subscription',
    customer: 'cus_ancien',
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
    items: {
      object: 'list',
      has_more: hasMore,
      data: [
        {
          id: 'si_page_1',
          object: 'subscription_item',
          quantity: 1,
          current_period_start: T0,
          current_period_end: T0 + 2_592_000,
          price: {
            id: 'price_socle',
            object: 'price',
            product: 'prod_1',
            currency: 'eur',
            unit_amount: 1900,
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
  };
}

function facture(id: string, amount: number, paidAt: number) {
  return {
    id,
    object: 'invoice',
    status: 'paid',
    amount_paid: amount,
    currency: 'eur',
    billing_reason: 'subscription_cycle',
    customer: 'cus_ancien',
    livemode: false,
    created: paidAt,
    status_transitions: { paid_at: paidAt },
    metadata: {},
  };
}

describe('resynchronisation Stripe (e2e)', () => {
  let app: INestApplication<App>;
  let db: DrizzleDatabase;
  let core: CoreService;
  let visitorKeys: VisitorKeyService;
  let projet: TestProject;
  let lecteur: SignedUpUser;
  let ecritAvant: string;
  const created: string[] = [];
  const reservations: string[] = [];

  /** Les paramètres du dernier `invoices.list`, pour éprouver la borne. */
  let invoicesParams: Record<string, unknown> | undefined;
  /** Les items paginés séparément quand la liste dit `has_more`. */
  const itemsPagines = [
    {
      id: 'si_page_2',
      object: 'subscription_item',
      quantity: 4,
      current_period_start: T0,
      current_period_end: T0 + 2_592_000,
      price: {
        id: 'price_module',
        object: 'price',
        product: 'prod_2',
        currency: 'eur',
        unit_amount: 500,
        recurring: { interval: 'month', interval_count: 1 },
      },
    },
  ];

  const clients = [client('cus_ancien', VISITEUR), client('cus_muet')];
  let abonnements = [abonnement('sub_ancien')];
  const factures = [facture('in_1', 4900, T0), facture('in_2', 1900, T0 + 10)];

  const api = {
    customers: { list: () => pages(clients) },
    subscriptions: { list: () => pages(abonnements) },
    subscriptionItems: { list: () => pages(itemsPagines) },
    invoices: {
      list: (params: Record<string, unknown>) => {
        invoicesParams = params;

        return pages(factures);
      },
    },
  };

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      // Seul le client sortant est doublé : tout le reste de la chaîne est le
      // vrai, y compris les réservations et l'attribution.
      builder
        .overrideProvider(StripeConnectService)
        .useValue({ api }),
    );

    db = app.get<DrizzleDatabase>(DRIZZLE);
    core = app.get(CoreService);
    visitorKeys = app.get(VisitorKeyService);

    projet = await createProject(db, { name: 'e2e resync' });
    created.push(projet.id);

    lecteur = await signUp(app, 'Lecteur resync');
    await joinOrganization(db, await organizationId(db), lecteur.id, 'member');

    await db.insert(integrations).values({
      projectId: projet.id,
      provider: 'stripe',
      externalAccountId: ACCOUNT,
      scope: 'read_only',
      livemode: false,
      connectedAt: new Date((T0 + 1000) * 1000),
    });

    // Un paiement déjà écrit par un webhook, sans visiteur : le site n'avait pas
    // encore posé son identifiant. C'est exactement ce que le rattrapage doit
    // réparer.
    const written = await core.ingest({
      projectId: projet.id,
      type: 'stripe.subscription.renewed',
      occurredAt: new Date(T0 * 1000),
      attributes: {},
      properties: { 'payment.amount': 4900, 'payment.currency': 'eur' },
      source: 'server',
    });

    ecritAvant = written.id;
    reservations.push('evt_avant');

    await db.insert(stripeWebhookEvents).values({
      eventId: 'evt_avant',
      projectId: projet.id,
      customerId: 'cus_ancien',
      writtenEventId: written.id,
    });
  });

  afterAll(async () => {
    await db
      .delete(stripeWebhookEvents)
      .where(inArray(stripeWebhookEvents.eventId, reservations));
    await db
      .delete(stripeSubscriptions)
      .where(inArray(stripeSubscriptions.projectId, created));
    await db
      .delete(stripeCustomers)
      .where(inArray(stripeCustomers.projectId, created));
    await db.delete(events).where(inArray(events.projectId, created));
    await db.delete(sessions).where(inArray(sessions.projectId, created));
    await db.delete(projects).where(inArray(projects.id, created));
    await db.delete(users).where(eq(users.id, lecteur.id));
    await app.close();
  });

  const resync = async (projectId = projet.id) => {
    const response = await request(app.getHttpServer())
      .post(`/v1/projects/${projectId}/revenue/sync`)
      .set('Cookie', lecteur.cookies)
      .expect(200);

    for (const ligne of factures) reservations.push(ligne.id);

    return expectMatchesContract(response.body, syncReportSchema);
  };

  it('apprend les paires, range les abonnements et rejoue les factures', async () => {
    const rapport = await resync();

    // `cus_muet` n'a pas d'identifiant de visiteur : il n'est pas appris, et
    // c'est le cas normal d'un client qui n'a jamais consenti.
    expect(rapport).toEqual({
      customers: 1,
      subscriptions: 1,
      invoices: 2,
      skipped: 0,
    });
  });

  it('rattache rétroactivement ce qui était déjà écrit', async () => {
    const [avant] = await db
      .select({ visitorKey: events.visitorKey })
      .from(events)
      .where(eq(events.id, ecritAvant));

    // Le paiement écrit avant le rattrapage désigne désormais quelqu'un. C'est
    // la seule réparation possible pour un client antérieur à l'installation,
    // et elle ne demande rien au site sinon de poser sa metadata un jour.
    expect(avant.visitorKey).toBe(
      visitorKeys.computeStable(projet.id, VISITEUR),
    );
  });

  it('borne les factures rejouées à ce qui précède la connexion', () => {
    // Au-delà, les webhooks ont déjà écrit : rejouer doublerait le revenu. La
    // réservation l'empêcherait, mais s'en remettre à elle logerait une règle
    // métier dans un mécanisme de secours.
    expect(invoicesParams).toMatchObject({
      status: 'paid',
      created: { lt: T0 + 1000 },
    });
  });

  it('écrit les factures rejouées, attribuées et marquées comme telles', async () => {
    const lignes = await db
      .select({
        type: events.type,
        properties: events.properties,
        visitorKey: events.visitorKey,
        sessionId: events.sessionId,
      })
      .from(events)
      .where(eq(events.projectId, projet.id));

    const rejouees = lignes.filter(
      (ligne) => ligne.properties['stripe.replayed'] === true,
    );

    expect(rejouees).toHaveLength(2);
    expect(rejouees[0]).toMatchObject({
      type: 'stripe.subscription.renewed',
      // Attribuée à l'écriture : la passe des clients a tourné avant celle des
      // factures, exprès.
      visitorKey: visitorKeys.computeStable(projet.id, VISITEUR),
      // Un paiement rapporté par un serveur n'a pas de visite.
      sessionId: null,
    });
  });

  it('range l’abonnement listé', async () => {
    const [abo] = await db
      .select()
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.projectId, projet.id));

    expect(abo).toMatchObject({
      stripeId: 'sub_ancien',
      customerId: 'cus_ancien',
      status: 'active',
    });

    const items = await db
      .select()
      .from(stripeSubscriptionItems)
      .where(eq(stripeSubscriptionItems.subscriptionId, abo.id));

    expect(items).toHaveLength(1);
  });

  it('repagine les lignes que la liste a tronquées', async () => {
    // Une réponse de liste ne rend que dix items, et seul `has_more` le dit. Un
    // abonnement à douze produits serait rangé amputé de deux, avec un total
    // plausible et faux.
    abonnements = [abonnement('sub_ancien', true)];

    await resync();

    const [abo] = await db
      .select()
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.projectId, projet.id));

    const items = await db
      .select()
      .from(stripeSubscriptionItems)
      .where(eq(stripeSubscriptionItems.subscriptionId, abo.id));

    expect(items.map((item) => item.stripeId)).toEqual(['si_page_2']);
  });

  it('ne réécrit rien quand on relance', async () => {
    const rapport = await resync();

    // `skipped` n'est pas un échec : c'est la preuve que le bouton
    // « resynchroniser » peut être pressé deux fois de suite sans conséquence.
    expect(rapport).toMatchObject({ customers: 0, invoices: 0, skipped: 2 });

    const lignes = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.projectId, projet.id));

    // Le paiement d'avant, plus les deux rejouées. Rien de plus.
    expect(lignes).toHaveLength(3);
  });

  it('refuse un projet sur lequel aucun compte n’est branché', async () => {
    const orphelin = await createProject(db, { name: 'e2e resync orphelin' });

    created.push(orphelin.id);

    await request(app.getHttpServer())
      .post(`/v1/projects/${orphelin.id}/revenue/sync`)
      .set('Cookie', lecteur.cookies)
      .expect(404);
  });
});

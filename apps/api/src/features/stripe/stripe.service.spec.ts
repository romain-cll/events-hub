import type Stripe from 'stripe';

import type { CoreService } from '../../core/core.service';
import type { DrizzleDatabase } from '../../database/database.module';
import type { IntegrationsService } from '../../integrations/integrations.service';
import type { StripeConnectService } from '../../integrations/stripe-connect.service';
import { StripeService } from './stripe.service';
import type { SubscriptionStore } from './subscription-store.service';

/**
 * Ce qui arrive quand quelque chose échoue **après** que l'événement est écrit.
 *
 * C'est la pire panne que ce module puisse produire, et elle est invisible : la
 * réservation relâchée fait rejouer Stripe, le rejeu écrit le paiement une
 * seconde fois, le revenu du jour double, et la donnée reste plausible.
 *
 * Deux tests, un de chaque côté de l'écriture. Ils n'éprouvent qu'une chose —
 * **qui appelle `delete`** — et c'est tout ce qui sépare un doublon d'un
 * rattachement manquant.
 */

const PROJECT_ID = '2e95b1b6-2a96-443a-919f-2b3661106689';

const EVENT = {
  id: 'evt_test',
  type: 'invoice.paid',
  account: 'acct_test',
  created: 1_788_000_000,
  livemode: false,
  data: {
    object: {
      id: 'in_test',
      object: 'invoice',
      customer: 'cus_test',
      amount_paid: 4900,
      currency: 'eur',
      billing_reason: 'subscription_cycle',
    },
  },
} as unknown as Stripe.Event;

/**
 * Un double de Drizzle réduit aux quatre chaînes que ce service emprunte.
 *
 * `update` est le maillon qu'on fait tomber : c'est celui du rattachement, la
 * première chose qui s'exécute une fois l'événement en base.
 */
function fakeDb({ updateFails }: { updateFails: boolean }) {
  const del = jest.fn().mockReturnValue({ where: jest.fn() });

  return {
    del,
    db: {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ eventId: EVENT.id }]),
          }),
          onConflictDoUpdate: () => Promise.resolve(undefined),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () =>
            updateFails
              ? Promise.reject(new Error('base indisponible'))
              : Promise.resolve(undefined),
        }),
      }),
      delete: del,
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      query: {
        stripeCustomers: { findFirst: () => Promise.resolve(undefined) },
      },
    } as unknown as DrizzleDatabase,
  };
}

/**
 * Un double de l'API Stripe réduit au seul chemin du règlement.
 *
 * `settles: false` rend un client qui **échoue** : c'est le cas qui compte, et
 * il est aussi celui que toutes les autres assertions de ce fichier
 * traversaient déjà sans le dire.
 */
function fakeStripe(settles: boolean) {
  return {
    invoicePayments: {
      list: () =>
        settles
          ? Promise.resolve({
              data: [
                {
                  payment: {
                    charge: {
                      balance_transaction: {
                        amount: 4501,
                        currency: 'eur',
                        exchange_rate: 0.9184,
                      },
                    },
                  },
                },
              ],
            })
          : Promise.reject(new Error('compte injoignable')),
    },
  };
}

function serviceAvec({
  updateFails = false,
  ingestFails = false,
  settles = false,
}: {
  updateFails?: boolean;
  ingestFails?: boolean;
  settles?: boolean;
} = {}) {
  const { db, del } = fakeDb({ updateFails });

  // Les commandes sont retenues plutôt que relues dans `mock.calls` : le double
  // est typé sans paramètre, et TypeScript refuse alors d'indexer un tuple vide.
  const ingested: { properties: Record<string, unknown> }[] = [];

  const ingest = jest.fn((command: { properties: Record<string, unknown> }) => {
    ingested.push(command);

    return ingestFails
      ? Promise.reject(new Error('écriture refusée'))
      : Promise.resolve({ id: 'evt-écrit' });
  });

  const service = new StripeService(
    db,
    {
      verifyWebhook: () => EVENT,
      api: fakeStripe(settles),
    } as unknown as StripeConnectService,
    {
      findByAccount: () => Promise.resolve({ projectId: PROJECT_ID }),
    } as unknown as IntegrationsService,
    { ingest } as unknown as CoreService,
    // La projection d'abonnement n'a rien à voir avec la réservation : un double
    // inerte suffit, et le rendre bavard ferait passer ce test pour un test de
    // la projection.
    { save: () => Promise.resolve(true) } as unknown as SubscriptionStore,
  );

  return { service, del, ingest, ingested };
}

describe('StripeService — la réservation et l’écriture', () => {
  it('relâche la réservation quand l’écriture elle-même échoue', async () => {
    const { service, del, ingest } = serviceAvec({ ingestFails: true });

    await expect(
      service.handle(Buffer.from('{}'), 'signature'),
    ).rejects.toThrow();

    // Rien n'est en base : le rejeu de Stripe est le seul filet qui reste, et il
    // doit pouvoir passer.
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalled();
  });

  it('ne relâche rien quand l’échec survient après l’écriture', async () => {
    const { service, del } = serviceAvec({ updateFails: true });

    // Ne lève pas : l'événement est écrit, et ce qui a échoué est réparable.
    await expect(
      service.handle(Buffer.from('{}'), 'signature'),
    ).resolves.toBeUndefined();

    // Le test du lot. Relâcher ici ferait rejouer Stripe, et le rejeu écrirait
    // le paiement une seconde fois — le revenu double sans que rien ne le dise.
    expect(del).not.toHaveBeenCalled();
  });
});

describe('StripeService — le règlement', () => {
  it('recopie le montant réglé sur le paiement', async () => {
    const { service, ingested } = serviceAvec({ settles: true });

    await service.handle(Buffer.from('{}'), 'signature');

    expect(ingested[0]).toMatchObject({
      properties: {
        'payment.amount': 4900,
        'payment.currency': 'eur',
        'payment.settled': 4501,
        'payment.settled_currency': 'eur',
        'payment.exchange_rate': 0.9184,
      },
    });
  });

  it('écrit quand même le paiement quand Stripe ne répond pas', async () => {
    // Le test du lot. Un compte injoignable, une clé expirée, une limite de
    // débit — aucune de ces pannes ne justifie de **perdre un paiement**. La
    // ligne part sans règlement, et l'écran la montrera non convertie plutôt
    // que de ne pas la montrer.
    const { service, del, ingested } = serviceAvec({ settles: false });

    await expect(
      service.handle(Buffer.from('{}'), 'signature'),
    ).resolves.toBeUndefined();

    expect(ingested[0].properties['payment.amount']).toBe(4900);
    expect(ingested[0].properties).not.toHaveProperty('payment.settled');
    // Et surtout : la réservation tient. La relâcher ferait rejouer Stripe, et
    // le rejeu écrirait le paiement une seconde fois.
    expect(del).not.toHaveBeenCalled();
  });
});

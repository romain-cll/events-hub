import type Stripe from 'stripe';

import { projectionOf } from './subscription-projection';

/**
 * La recopie, et la seule chose qu'elle a le droit de faire : changer d'unité.
 *
 * Ce qui est éprouvé ici tient en une phrase — rien n'est calculé. Pas de
 * montant mensualisé, pas de `unit_amount × quantity`, pas de statut réduit à un
 * booléen. Le jour où quelqu'un ajoutera « juste un petit total », un de ces
 * tests tombera.
 */

const CREATED = 1_788_000_000;

/** Un abonnement Stripe crédible, réduit à ce que la projection lit. */
function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    currency: 'eur',
    created: CREATED,
    start_date: CREATED,
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
      data: [
        {
          id: 'si_1',
          object: 'subscription_item',
          quantity: 2,
          current_period_start: CREATED,
          current_period_end: CREATED + 2_592_000,
          price: {
            id: 'price_1',
            object: 'price',
            product: 'prod_1',
            currency: 'eur',
            unit_amount: 1900,
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

function evenement(
  object: Record<string, unknown>,
  type = 'customer.subscription.updated',
  created = CREATED + 60,
): Stripe.Event {
  // `as unknown as` : on ne fabrique que les champs que la projection lit, et
  // reconstituer un `Stripe.Event` entier ne prouverait rien de plus.
  return {
    id: 'evt_1',
    type,
    created,
    data: { object },
  } as unknown as Stripe.Event;
}

describe('projectionOf', () => {
  it('recopie l’abonnement sans rien calculer', () => {
    const projection = projectionOf(evenement(subscription()));

    expect(projection?.subscription).toEqual({
      stripeId: 'sub_1',
      customerId: 'cus_1',
      // La chaîne de Stripe, pas un booléen : `trialing` et `past_due` ne sont
      // ni actifs ni résiliés.
      status: 'active',
      currency: 'eur',
      createdAt: new Date(CREATED * 1000),
      startDate: new Date(CREATED * 1000),
      cancelAt: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
      trialStart: null,
      trialEnd: null,
      collectionMethod: 'charge_automatically',
      livemode: false,
      // L'instant de l'événement, pas celui de l'abonnement : c'est lui qui
      // départage deux webhooks livrés dans le désordre.
      observedAt: new Date((CREATED + 60) * 1000),
    });
  });

  it('recopie les lignes, période comprise', () => {
    const projection = projectionOf(evenement(subscription()));

    expect(projection?.items).toEqual([
      {
        stripeId: 'si_1',
        priceId: 'price_1',
        productId: 'prod_1',
        quantity: 2,
        // 1900, et surtout pas 3800 : figer le produit par la quantité rendrait
        // le total impossible à réconcilier dès qu'une remise s'en mêle.
        unitAmount: 1900,
        currency: 'eur',
        // `month`, jamais mensualisé : la cadence est une donnée, la
        // mensualisation un calcul de lecture.
        interval: 'month',
        intervalCount: 1,
        currentPeriodStart: new Date(CREATED * 1000),
        currentPeriodEnd: new Date((CREATED + 2_592_000) * 1000),
      },
    ]);
  });

  it('garde un montant absent absent', () => {
    // Un prix mesuré à l'usage n'a pas de montant unitaire. Écrire zéro ferait
    // entrer un abonnement payant dans les lectures comme un abonnement gratuit.
    const mesure = subscription();
    const [item] = (mesure.items as { data: Record<string, unknown>[] }).data;
    const price = item.price as Record<string, unknown>;

    price.unit_amount = null;
    price.recurring = null;
    item.quantity = undefined;

    expect(projectionOf(evenement(mesure))?.items[0]).toMatchObject({
      unitAmount: null,
      quantity: null,
      interval: null,
      intervalCount: null,
    });
  });

  it('projette la résiliation telle que Stripe la décrit', () => {
    // `deleted` ne supprime rien : la ligne résiliée *est* ce dont une lecture
    // de churn a besoin. Et `canceled_at` n'est pas `ended_at` — la demande
    // précède la fin réelle d'une période entière.
    const resilie = subscription({
      status: 'canceled',
      canceled_at: CREATED + 100,
      ended_at: CREATED + 2_592_000,
    });

    const projection = projectionOf(
      evenement(resilie, 'customer.subscription.deleted'),
    );

    expect(projection?.subscription).toMatchObject({
      status: 'canceled',
      canceledAt: new Date((CREATED + 100) * 1000),
      endedAt: new Date((CREATED + 2_592_000) * 1000),
    });
  });

  it('accepte un client rendu étendu plutôt qu’en référence', () => {
    const etendu = subscription({
      customer: { id: 'cus_2', object: 'customer' },
    });

    expect(projectionOf(evenement(etendu))?.subscription.customerId).toBe(
      'cus_2',
    );
  });

  it('n’écrit rien quand l’abonnement n’a pas de client', () => {
    // Toute lecture de cohorte passe par le client : une ligne qu'aucune
    // jointure ne retrouvera vaut moins que pas de ligne.
    expect(projectionOf(evenement(subscription({ customer: null })))).toBeNull();
  });

  it('ignore un événement qui ne parle pas d’abonnement', () => {
    const facture = { id: 'in_1', object: 'invoice', amount_paid: 4900 };

    expect(projectionOf(evenement(facture, 'invoice.paid'))).toBeNull();
  });

  it('projette toute la famille, sans énumérer ses membres', () => {
    // Le préfixe suffit : une variante que Stripe ajoutera demain sera projetée
    // sans qu'on ait à revenir ici, comme le pass-through du fil.
    for (const type of [
      'customer.subscription.created',
      'customer.subscription.paused',
      'customer.subscription.resumed',
      'customer.subscription.pending_update_applied',
    ]) {
      expect(projectionOf(evenement(subscription(), type))).not.toBeNull();
    }
  });
});

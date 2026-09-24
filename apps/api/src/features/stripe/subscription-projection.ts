import type Stripe from 'stripe';

/**
 * Traduire un objet `Subscription` de Stripe en lignes de table, sans rien
 * décider.
 *
 * ## Une recopie, pas une interprétation
 *
 * Chaque champ part tel quel. Le seul travail fait ici est un changement
 * d'unité — Stripe date en **secondes** depuis l'époque, Postgres en instants —
 * et c'est le seul qui ne perde rien.
 *
 * Ce qui n'est pas fait, et ne doit pas l'être : mensualiser un montant, figer
 * un `unit_amount × quantity`, réduire `status` à un booléen, normaliser une
 * cadence. Tout ça se recalcule à la lecture, et tout ça divergerait de Stripe
 * à la première remise.
 *
 * ## Aucun appel sortant
 *
 * La charge utile du webhook **est** l'objet `Subscription`, items compris. Il
 * n'y a donc rien à aller chercher, et c'est ce qui rend cette projection
 * insensible aux quotas de l'API Connect.
 *
 * ⚠️ Ça cesse d'être vrai au rattrapage d'historique : `subscriptions.list`
 * tronque `items` à dix. Le lot qui l'ajoutera devra paginer.
 */

/** Un instant Stripe — des secondes — rendu en `Date`, ou `null`. */
function instant(seconds: number | null | undefined): Date | null {
  return seconds == null ? null : new Date(seconds * 1000);
}

/** L'identifiant d'un champ qui peut arriver étendu ou en simple référence. */
function idOf(
  value: string | { id: string } | null | undefined,
): string | null {
  if (value == null) return null;

  return typeof value === 'string' ? value : value.id;
}

/** Ce qu'on écrit dans `stripe_subscriptions`, moins ce que la base ajoute. */
export interface ProjectedSubscription {
  stripeId: string;
  customerId: string;
  status: string;
  currency: string;
  createdAt: Date;
  startDate: Date;
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  trialStart: Date | null;
  trialEnd: Date | null;
  collectionMethod: string;
  livemode: boolean;
  observedAt: Date;
}

/** Une ligne d'abonnement, telle qu'on la range. */
export interface ProjectedItem {
  stripeId: string;
  priceId: string;
  productId: string | null;
  quantity: number | null;
  unitAmount: number | null;
  currency: string;
  interval: string | null;
  intervalCount: number | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export interface Projection {
  subscription: ProjectedSubscription;
  items: ProjectedItem[];
}

/**
 * Les types d'événement dont la charge utile est un abonnement.
 *
 * `created`, `updated`, `deleted`, `paused`, `resumed`,
 * `pending_update_applied`… — la famille entière, sans en énumérer les membres :
 * le préfixe suffit, et une nouvelle variante sera projetée sans qu'on ait à y
 * revenir. C'est la même posture que le pass-through du fil.
 *
 * ⚠️ `customer.subscription.deleted` ne supprime **rien**. Stripe y envoie
 * l'abonnement avec `status: 'canceled'` et son `ended_at` : la recopie suffit,
 * et c'est exactement la ligne dont une lecture de churn a besoin. Supprimer la
 * ligne effacerait le départ en même temps que l'abonnement.
 */
const SUBSCRIPTION_PREFIX = 'customer.subscription.';

/**
 * La projection d'un événement, ou `null` s'il ne parle pas d'abonnement.
 *
 * `null` plutôt qu'une exception : la grande majorité des webhooks n'a rien à
 * voir avec un abonnement, et ce n'est pas une anomalie.
 */
export function projectionOf(event: Stripe.Event): Projection | null {
  if (!event.type.startsWith(SUBSCRIPTION_PREFIX)) return null;

  const object = event.data.object;

  if (!('object' in object) || object.object !== 'subscription') return null;

  // L'instant de l'observation, pas celui de l'écriture : c'est lui qui
  // reconnaît un webhook livré en retard.
  return rowsOf(object, new Date(event.created * 1000));
}

/**
 * La même projection, à partir de l'objet seul.
 *
 * C'est la porte du **rattrapage** : `subscriptions.list` rend des abonnements
 * sans événement autour, et il n'y a alors pas d'`event.created` à prendre pour
 * date d'observation. L'appelant passe l'instant de sa lecture, qui est
 * exactement ce que `observedAt` veut dire.
 *
 * Conséquence assumée : un rattrapage rend l'état plus « récent » que tout
 * webhook antérieur, donc un webhook resté en file pendant la resynchronisation
 * sera écarté. C'est le bon arbitrage — la lecture directe chez Stripe est plus
 * fraîche que n'importe quelle notification déjà en route.
 */
export function rowsOf(
  subscription: Stripe.Subscription,
  observedAt: Date,
): Projection | null {
  const customerId = idOf(subscription.customer);

  // Un abonnement sans client ne se rattache à personne, et toute lecture de
  // cohorte passe par lui. Mieux vaut ne rien écrire que d'écrire une ligne
  // qu'aucune jointure ne retrouvera.
  if (!customerId) return null;

  return {
    subscription: {
      stripeId: subscription.id,
      customerId,
      status: subscription.status,
      currency: subscription.currency,
      createdAt: new Date(subscription.created * 1000),
      startDate: new Date(subscription.start_date * 1000),
      cancelAt: instant(subscription.cancel_at),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: instant(subscription.canceled_at),
      endedAt: instant(subscription.ended_at),
      trialStart: instant(subscription.trial_start),
      trialEnd: instant(subscription.trial_end),
      collectionMethod: subscription.collection_method,
      livemode: subscription.livemode,
      observedAt,
    },
    items: subscription.items.data.map(itemOf),
  };
}

function itemOf(item: Stripe.SubscriptionItem): ProjectedItem {
  const { price } = item;

  return {
    stripeId: item.id,
    priceId: price.id,
    productId: idOf(price.product),
    // `?? null` et pas `?? 1` : un prix mesuré à l'usage n'a pas de quantité,
    // et en inventer une ferait apparaître un montant là où il n'y en a pas.
    quantity: item.quantity ?? null,
    unitAmount: price.unit_amount,
    // Celle du prix, pas celle de l'abonnement : elles coïncident toujours chez
    // Stripe, mais c'est le prix qui porte le montant qu'elle qualifie.
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    currentPeriodStart: instant(item.current_period_start),
    currentPeriodEnd: instant(item.current_period_end),
  };
}

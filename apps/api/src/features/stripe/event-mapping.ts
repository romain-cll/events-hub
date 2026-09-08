import type Stripe from 'stripe';

/**
 * Traduire le vocabulaire de Stripe dans celui du hub.
 *
 * ## Le pass-through est le défaut, et c'est délibéré
 *
 * Le type Stripe devient notre type, préfixé. `customer.subscription.updated`
 * arrive comme `stripe.customer.subscription.updated` sans qu'une ligne ait été
 * écrite pour lui, et il traverse tout le pipeline : c'est la promesse du socle,
 * `type` est une chaîne libre et un type jamais vu s'inscrit tout seul au
 * vocabulaire du projet.
 *
 * Conséquence directe : **accueillir un nouvel événement Stripe ne demande aucun
 * code**. Le jour où on voudra les litiges ou les remboursements partiels, il
 * suffira de les cocher dans le tableau de bord Stripe.
 *
 * ## L'affinage, seulement là où Stripe sous-discrimine
 *
 * `invoice.paid` recouvre trois choses qui n'ont pas le même sens pour le
 * produit : un premier abonnement, un renouvellement, un changement de plan.
 * Les confondre fausserait la question à laquelle le hub existe pour répondre —
 * d'où viennent les **nouveaux** clients — et ferait passer une expansion pour
 * de la récurrence dans le MRR.
 *
 * Stripe le dit lui-même, dans `billing_reason`. On ne le déduit pas : deviner
 * à partir de « ce visiteur a-t-il déjà payé » se trompe dans les deux sens —
 * deux achats ponctuels distincts passeraient pour un renouvellement, et un vrai
 * renouvellement sans metadata passerait pour un nouveau client.
 */
const PREFIX = 'stripe';

/**
 * Ce que `billing_reason` fait d'une facture payée.
 *
 * Les raisons absentes d'ici retombent sur le pass-through : `manual` et
 * `subscription_threshold` existent, sont rares, et n'ont pas de sens produit
 * distinct tant que personne ne les lit. Leur inventer un type maintenant
 * figerait une interprétation qu'on n'a pas.
 */
const BY_BILLING_REASON: Partial<
  Record<Stripe.Invoice.BillingReason, string>
> = {
  subscription_create: `${PREFIX}.subscription.started`,
  subscription_cycle: `${PREFIX}.subscription.renewed`,
  subscription_update: `${PREFIX}.subscription.changed`,
};

/**
 * Le type d'événement du hub pour un webhook Stripe donné.
 *
 * `event.type` de Stripe est déjà pointé (`invoice.paid`), donc le préfixe
 * suffit à le rendre non ambigu au milieu des types inventés par les clients.
 */
export function typeOf(event: Stripe.Event): string {
  const object = event.data.object;

  if (event.type === 'invoice.paid' && 'billing_reason' in object) {
    const refined = object.billing_reason
      ? BY_BILLING_REASON[object.billing_reason]
      : undefined;

    if (refined) return refined;
  }

  return `${PREFIX}.${event.type}`;
}

/**
 * Ce qu'on garde d'un événement Stripe, et pourquoi si peu.
 *
 * L'objet complet pèse plusieurs kilo-octets et change de forme à chaque version
 * de leur API. Le recopier entier ferait grossir la table sans que personne ne le
 * lise, et donnerait l'illusion d'une fidélité qu'on ne maintiendrait pas.
 *
 * On extrait donc ce que les lectures de revenu demanderont : de quoi identifier
 * (les `id` de Stripe), de quoi compter (montant et devise), et de quoi
 * distinguer un compte de test d'un vrai. Le reste se retrouve chez Stripe, qui
 * en est la source.
 *
 * Les clés sont pointées comme celles du SDK. `payment.*` porte le fait produit,
 * `stripe.*` ce qui n'a de sens que chez eux — un jour où une autre source de
 * paiement arrivera, la première moitié tiendra encore.
 */
export function propertiesOf(event: Stripe.Event): Record<string, unknown> {
  const object = event.data.object;
  const amount = amountOf(object);

  return {
    'stripe.event.id': event.id,
    'stripe.event.type': event.type,
    'stripe.object.id': 'id' in object ? object.id : undefined,
    'stripe.customer.id': customerIdOf(object),
    'stripe.billing_reason':
      'billing_reason' in object ? object.billing_reason : undefined,
    'stripe.livemode': event.livemode,
    ...(amount === undefined
      ? {}
      : {
          // En **centimes**, comme Stripe les donne. Convertir ici ferait entrer
          // des flottants dans une donnée comptable, et chaque devise n'a pas le
          // même nombre de décimales — c'est à l'affichage de trancher.
          'payment.amount': amount,
          'payment.currency': currencyOf(object),
        }),
  };
}

/**
 * Le montant réellement encaissé, selon la nature de l'objet.
 *
 * Trois champs différents pour la même question, parce que Stripe n'a pas un
 * objet « paiement » unique. On prend systématiquement le montant **payé**, pas
 * le montant dû : une facture émise n'est pas du revenu.
 */
function amountOf(object: Stripe.Event.Data.Object): number | undefined {
  if ('amount_paid' in object && typeof object.amount_paid === 'number') {
    return object.amount_paid;
  }

  if ('amount_total' in object && typeof object.amount_total === 'number') {
    return object.amount_total;
  }

  if ('amount' in object && typeof object.amount === 'number') {
    return object.amount;
  }

  return undefined;
}

function currencyOf(object: Stripe.Event.Data.Object): string | undefined {
  return 'currency' in object && typeof object.currency === 'string'
    ? object.currency
    : undefined;
}

/** Le client Stripe, qu'il soit rendu en identifiant ou en objet développé. */
export function customerIdOf(
  object: Stripe.Event.Data.Object,
): string | undefined {
  if (!('customer' in object) || !object.customer) return undefined;

  // Stripe rend tantôt l'identifiant, tantôt l'objet développé, selon ce que
  // l'appel a demandé. L'union des objets d'événement ne le décrit pas assez
  // finement pour que le compilateur le sache : on constate la forme reçue.
  const customer: unknown = object.customer;

  if (typeof customer === 'string') return customer;

  return typeof customer === 'object' &&
    customer !== null &&
    'id' in customer &&
    typeof customer.id === 'string'
    ? customer.id
    : undefined;
}

/** L'instant de l'événement, tel que Stripe l'a daté (en secondes). */
export function occurredAtOf(event: Stripe.Event): Date {
  return new Date(event.created * 1000);
}

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
 * Les deux clés sous lesquelles le montant d'un paiement est rangé.
 *
 * Nommées ici parce que c'est ici qu'elles sont écrites : une lecture qui les
 * recopierait chez elle divergerait le jour où `propertiesOf` change d'avis, et
 * rendrait alors des totaux à zéro sans que rien n'échoue.
 */
export const AMOUNT_KEY = 'payment.amount';
export const CURRENCY_KEY = 'payment.currency';

/**
 * Quel type d'événement répond à quelle question de revenu.
 *
 * **Un paiement produit plusieurs événements Stripe**, tous porteurs du même
 * montant : additionner « ce qui porte un montant » compterait le même euro
 * quatre fois. Une lecture de revenu vise donc un type, et ce tableau est le
 * seul endroit où le choix est écrit.
 *
 * `one_time` vise le checkout parce que Stripe ne dit rien d'autre d'un
 * paiement ponctuel — il n'a pas de `billing_reason`. Les quatre ne
 * s'additionnent pas : un abonnement pris au checkout produit à la fois un
 * `started` et un `checkout.session.completed`.
 */
export const TYPE_BY_REVENUE_KIND = {
  new: `${PREFIX}.subscription.started`,
  recurring: `${PREFIX}.subscription.renewed`,
  change: `${PREFIX}.subscription.changed`,
  one_time: `${PREFIX}.checkout.session.completed`,
} as const;

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
    'stripe.customer.id': customerOf(object),
    'stripe.billing_reason':
      'billing_reason' in object ? object.billing_reason : undefined,
    'stripe.livemode': event.livemode,
    ...(amount === undefined
      ? {}
      : {
          // En **centimes**, comme Stripe les donne. Convertir ici ferait entrer
          // des flottants dans une donnée comptable, et chaque devise n'a pas le
          // même nombre de décimales — c'est à l'affichage de trancher.
          [AMOUNT_KEY]: amount,
          [CURRENCY_KEY]: currencyOf(object),
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

/** La clé que le site du client pose dans la metadata de ses objets Stripe. */
export const VISITOR_METADATA_KEY = 'eh_visitor_id';

/**
 * La clé de repli, pour un visiteur qui n'a pas consenti.
 *
 * Elle ne désigne pas la même chose que la première, et c'est tout l'enjeu :
 * `eh_visitor_id` désigne quelqu'un à travers ses visites, `eh_session_id`
 * désigne une visite. La seconde ne survit donc ni au lendemain ni à une demi
 * heure d'inactivité — un renouvellement facturé des mois plus tard ne sera
 * jamais attribué par elle.
 *
 * D'où la règle appliquée dans `attributionOf` : quand les deux sont posées,
 * c'est la durable qui gagne. Un site qui câble les deux n'a rien à arbitrer.
 */
export const SESSION_METADATA_KEY = 'eh_session_id';

/**
 * Le client concerné par un événement, qu'il soit **désigné** par l'objet ou
 * qu'il **soit** l'objet.
 *
 * `customer.created` et `customer.updated` n'ont pas de champ `customer` : le
 * client, c'est l'objet lui-même. Les traiter comme les autres perdrait
 * précisément les deux événements par lesquels un site annonce l'identité de
 * son client — donc la seule chose qui rende un renouvellement attribuable.
 *
 * On reconnaît la nature par `object`, que Stripe pose sur tous ses objets,
 * plutôt que par le type de l'événement : le premier décrit ce qu'on tient, le
 * second ce qui vient d'arriver, et c'est le premier qui répond ici.
 */
export function customerOf(
  object: Stripe.Event.Data.Object,
): string | undefined {
  if ('object' in object && object.object === 'customer') {
    const id: unknown = 'id' in object ? object.id : undefined;

    return typeof id === 'string' ? id : undefined;
  }

  return customerIdOf(object);
}

/**
 * La paire client ↔ visiteur que cet événement **affirme**, s'il en affirme une.
 *
 * C'est la seule source de vérité sur ce lien : un site le pose dans la metadata
 * de ses objets Stripe, et nous ne faisons que le constater. Rien n'est déduit
 * ici — un événement sans metadata ne dit rien, il ne dit pas « pas de
 * visiteur ».
 */
export function customerLinkOf(
  event: Stripe.Event,
): { customerId: string; visitorId: string } | undefined {
  const object = event.data.object;
  const visitorId = visitorIdOf(object);

  if (!visitorId) return undefined;

  const customerId = customerOf(object);

  return customerId ? { customerId, visitorId } : undefined;
}

/** L'identifiant de visiteur posé dans la metadata de cet objet, s'il y est. */
export function visitorIdOf(
  object: Stripe.Event.Data.Object,
): string | undefined {
  return metadataValueOf(object, VISITOR_METADATA_KEY);
}

/** La visite posée dans la metadata de cet objet, s'il y en a une. */
export function sessionIdOf(
  object: Stripe.Event.Data.Object,
): string | undefined {
  return metadataValueOf(object, SESSION_METADATA_KEY);
}

/**
 * Ce à quoi rattacher le paiement, et sous quelle nature.
 *
 * L'union discriminée plutôt que deux champs facultatifs : les deux ne se
 * combinent pas, et un appelant qui recevrait `{ visitorId?, sessionId? }`
 * pourrait les traiter tous les deux — donc écrire une identité durable et une
 * visite pour un même paiement, en ayant l'air de bien faire.
 *
 * La durable l'emporte quand les deux sont là. Un site qui pose les deux est un
 * site dont le visiteur a fini par consentir : la visite n'ajoute alors rien que
 * la durable ne dise déjà mieux.
 */
export type StripeAttribution =
  | { kind: 'visitor'; visitorId: string }
  | { kind: 'session'; sessionId: string };

export function attributionOf(
  object: Stripe.Event.Data.Object,
): StripeAttribution | undefined {
  const visitorId = visitorIdOf(object);

  if (visitorId) return { kind: 'visitor', visitorId };

  const sessionId = sessionIdOf(object);

  return sessionId ? { kind: 'session', sessionId } : undefined;
}

function metadataValueOf(
  object: Stripe.Event.Data.Object,
  key: string,
): string | undefined {
  if (!('metadata' in object)) return undefined;

  // L'union des objets d'événement ne décrit pas `metadata` assez finement pour
  // que le compilateur l'indexe : on constate la forme reçue, comme pour
  // `customer`.
  const metadata: unknown = object.metadata;

  if (typeof metadata !== 'object' || metadata === null) return undefined;

  const value = (metadata as Record<string, unknown>)[key];

  return typeof value === 'string' && value ? value : undefined;
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

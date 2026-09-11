import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';

/**
 * L'état courant des abonnements d'un compte Stripe connecté.
 *
 * ## Pourquoi le stocker alors que Stripe l'expose
 *
 * Parce que le flux d'événements ne peut pas y répondre. Il ne contient **rien
 * d'antérieur à la connexion** : un client abonné depuis deux ans n'a produit
 * aucun `subscription.started` chez nous, et aucune lecture de rétention, de
 * cohorte ou de churn ne tient sans lui. Interroger Stripe à chaque lecture
 * n'est pas une option : ses quotas Connect sont par plateforme, et une page de
 * tableau de bord ne peut pas dépendre d'un appel sortant.
 *
 * ## Recopie verbatim, et ce que ça interdit
 *
 * Chaque colonne porte ce que Stripe a écrit, sans retouche. `status` reste la
 * chaîne de Stripe — jamais réduite à un booléen « actif » : `trialing`,
 * `past_due`, `paused` et `unpaid` ne sont ni actifs ni résiliés, et les
 * écraser en deux valeurs perd exactement ce qu'une lecture de churn cherche.
 *
 * Ce qui n'est **pas** stocké, et ne doit pas l'être : un montant mensualisé, un
 * `unit_amount × quantity` figé, une cadence normalisée, un total toutes devises
 * confondues, un drapeau « client actif ». Tous se recalculent à la lecture, et
 * tous divergeraient de Stripe le jour où une remise, une taxe ou une proration
 * s'en mêle. Un client qui voit un écart avec son tableau de bord Stripe conclut
 * que c'est le nôtre qui ment — et il a raison, il n'a aucun moyen de trancher.
 *
 * ## Ce que « l'état courant » ne répond pas
 *
 * « Qui était abonné au 1er mars » n'est **pas** lisible ici, et Stripe n'expose
 * aucun historique de statut. Ce que ces colonnes permettent est un prédicat sur
 * les dates brutes — `start_date <= T AND (ended_at IS NULL OR ended_at > T)` —
 * qui ignore les pauses et les `past_due` traversés entre-temps. C'est une
 * approximation, elle est connue, et elle ne doit pas être maquillée en vérité.
 *
 * L'historique de plan n'est pas stocké non plus : il vit dans le flux, qui
 * porte déjà un type d'événement pour les changements d'abonnement.
 *
 * ## ⚠️ `canceledAt` n'est pas `endedAt`
 *
 * Le premier est l'instant de la **demande** de résiliation, le second la fin
 * réelle du service. Ils sont séparés d'une période entière quand la
 * résiliation prend effet en fin de cycle. Une lecture de churn qui prend le
 * premier avance tous les départs d'un mois.
 */
export const stripeSubscriptions = pgTable(
  'stripe_subscriptions',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Le `sub_…` de Stripe, tel quel. */
    stripeId: text().notNull(),
    /** Le `cus_…` : c'est par lui que la ligne rejoint un visiteur. */
    customerId: text().notNull(),
    /**
     * Le statut de Stripe, mot pour mot.
     *
     * `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `paused`,
     * `incomplete`, `incomplete_expired` — et la liste peut s'allonger sans
     * qu'on en soit prévenu. `text` plutôt qu'un `enum` pour cette raison : un
     * statut inconnu doit s'écrire, pas faire échouer l'ingestion.
     */
    status: text().notNull(),
    /** La devise de l'abonnement. Elle sépare les totaux, elle ne les convertit pas. */
    currency: text().notNull(),
    /** `created` de Stripe : quand l'abonnement a été créé chez eux. */
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /**
     * `start_date` : le début du service.
     *
     * Distinct de `createdAt` sur un abonnement migré ou antidaté, et c'est
     * celui-ci qui compte pour une cohorte.
     */
    startDate: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /** La résiliation programmée, quand une date a été posée à l'avance. */
    cancelAt: timestamp({ withTimezone: true, precision: 3 }),
    /** La résiliation prendra effet à la fin de la période en cours. */
    cancelAtPeriodEnd: boolean().notNull(),
    /** Quand la résiliation a été **demandée**. Voir l'avertissement ci-dessus. */
    canceledAt: timestamp({ withTimezone: true, precision: 3 }),
    /** Quand le service a réellement pris fin. C'est la date du churn. */
    endedAt: timestamp({ withTimezone: true, precision: 3 }),
    trialStart: timestamp({ withTimezone: true, precision: 3 }),
    trialEnd: timestamp({ withTimezone: true, precision: 3 }),
    /** `charge_automatically` ou `send_invoice` : un impayé ne se lit pas pareil. */
    collectionMethod: text().notNull(),
    /** Un abonnement de test ne doit pas compter dans le revenu affiché. */
    livemode: boolean().notNull(),
    /**
     * L'instant de l'**observation**, pas de l'écriture : `event.created`.
     *
     * C'est le garde-fou d'ordre, et il n'est pas optionnel. Stripe ne garantit
     * pas l'ordre de livraison de ses webhooks, et `Subscription` ne porte aucun
     * champ de version. Sans cette colonne, un `.updated` livré en retard
     * ressusciterait un abonnement résilié — la ligne redeviendrait `active`, et
     * rien ne le signalerait.
     *
     * L'upsert ne s'applique donc que si l'observation est **plus récente** que
     * celle déjà en base.
     */
    observedAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /** Quand nous avons écrit la ligne. Diagnostic seul : jamais une donnée métier. */
    projectedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Le même `sub_…` chez deux projets n'a rien à voir avec lui-même : les
    // projets ne partagent ni leurs clients ni leurs comptes de paiement.
    unique().on(table.projectId, table.stripeId),
    index('stripe_subscriptions_project_customer_idx').on(
      table.projectId,
      table.customerId,
    ),
  ],
);

export type StripeSubscription = typeof stripeSubscriptions.$inferSelect;

/**
 * Les lignes d'un abonnement : un produit, un prix, une quantité, une période.
 *
 * ## Pourquoi une seconde table
 *
 * Parce qu'aplatir obligerait à élire `items.data[0]`. C'est faux pour tout
 * abonnement multi-produits — un forfait plus un module, une place plus un
 * support — et l'erreur serait **invisible** : la ligne existe, elle est juste
 * incomplète. Une table dit la vérité par construction.
 *
 * Ce que ça coûte : une jointure sur toute lecture de montant, et un
 * **remplacement complet** des items à chaque mise à jour — un client qui retire
 * un produit fait disparaître une ligne, il n'en met pas une à zéro.
 *
 * ## La période vit ici, et c'est nouveau
 *
 * `current_period_start` et `current_period_end` ne sont plus sur
 * `Subscription` : Stripe les a déplacés sur l'item. Un abonnement dont les
 * lignes ont des cycles différents n'a plus **une** période, et c'est la raison
 * du déplacement — la lire ailleurs qu'ici serait en inventer une.
 *
 * ## `unitAmount` est nullable, et ce n'est pas un oubli
 *
 * Un prix mesuré à l'usage, ou par paliers, n'a pas de montant unitaire : le
 * montant n'existe qu'une fois la consommation connue, sur la facture. Écrire
 * zéro ferait entrer un abonnement payant dans les lectures comme un abonnement
 * gratuit.
 */
export const stripeSubscriptionItems = pgTable(
  'stripe_subscription_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * L'abonnement porteur, par notre identifiant.
     *
     * `cascade` : un item ne décrit rien sans son abonnement, et le
     * remplacement des items à chaque mise à jour passe par une suppression.
     */
    subscriptionId: uuid()
      .notNull()
      .references(() => stripeSubscriptions.id, { onDelete: 'cascade' }),
    /** Le `si_…` de Stripe, tel quel. */
    stripeId: text().notNull(),
    /** Le `price_…`. C'est lui qui identifie un plan, pas son libellé. */
    priceId: text().notNull(),
    /** Le `prod_…`, quand le prix le porte en clair. */
    productId: text(),
    /** Nombre d'unités. Absent sur un prix mesuré à l'usage. */
    quantity: integer(),
    /** Le montant unitaire, **en centimes**, tel que Stripe l'écrit. */
    unitAmount: integer(),
    currency: text().notNull(),
    /**
     * La cadence de facturation, mot pour mot : `day`, `week`, `month`, `year`.
     *
     * Jamais normalisée en mois. Mensualiser est un calcul de lecture — le MRR
     * le fait, en divisant l'annuel par douze — et le figer ici rendrait le
     * chiffre impossible à réconcilier avec Stripe.
     *
     * `null` sur un prix non récurrent, qui peut exister dans un abonnement.
     */
    interval: text(),
    /** « tous les N intervalles ». Trimestriel s'écrit `month` × 3. */
    intervalCount: integer(),
    /** Début de la période en cours de **cette ligne**. */
    currentPeriodStart: timestamp({ withTimezone: true, precision: 3 }),
    /** Fin de la période en cours. C'est la date du prochain renouvellement. */
    currentPeriodEnd: timestamp({ withTimezone: true, precision: 3 }),
  },
  (table) => [unique().on(table.subscriptionId, table.stripeId)],
);

export type StripeSubscriptionItem =
  typeof stripeSubscriptionItems.$inferSelect;

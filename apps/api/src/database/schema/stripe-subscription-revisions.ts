import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { projects } from './projects';
import { stripeSubscriptions } from './stripe-subscriptions';

/**
 * Chaque fois que le montant mensuel d'un abonnement change, une ligne.
 *
 * ## Pourquoi cette table existe alors que le MRR se calcule à la demande
 *
 * Le MRR **courant** se lit à tout moment dans `stripe_subscriptions` et ses
 * items. Sa **décomposition** — ce qui a fait bouger le chiffre depuis le mois
 * dernier — demande l'écart entre deux instants, et cet écart n'est
 * reconstructible nulle part :
 *
 * - Stripe n'expose aucun « état de l'abonnement au 1er mars » ;
 * - son API Events ne remonte que trente jours ;
 * - le MRR de leur tableau de bord n'est pas dans l'API publique.
 *
 * Et notre propre projection écrase : une montée de gamme remplace les items, et
 * l'ancien montant disparaît. **Chaque mois sans cette table est un mois absent
 * du waterfall pour toujours**, ce qui est la seule raison d'écrire ces lignes
 * avant même de savoir les lire.
 *
 * ## Des faits, pas des causes
 *
 * On range un avant, un après, un statut. **Pas** « expansion », « churn » ou
 * « nouveau » : ce sont des interprétations, elles se déduisent des deux
 * montants, et les figer en base les trancherait avant que la lecture ait dit ce
 * dont elle a besoin. Même posture que partout ailleurs sur les données Stripe —
 * on recopie, on n'interprète pas.
 *
 * ## Ce qu'il ne faut pas en attendre
 *
 * L'historique **démarre à la mise en service**. Les abonnements déjà en base
 * n'ont aucune révision tant qu'ils ne bougent pas : la courbe partira plate, et
 * ce n'est pas une panne. Le passé antérieur ne se rattrape qu'en repartant des
 * factures, qui est un autre chantier.
 */
export const stripeSubscriptionRevisions = pgTable(
  'stripe_subscription_revisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * Le projet, recopié depuis l'abonnement.
     *
     * Redondant avec la jointure, et c'est voulu : toute lecture est cloisonnée
     * par projet, et la faire passer par `stripe_subscriptions` pour l'obtenir
     * imposerait cette jointure à chaque requête de la série temporelle.
     */
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * L'abonnement concerné.
     *
     * `cascade` : une révision ne décrit rien sans lui, comme les items.
     */
    subscriptionId: uuid()
      .notNull()
      .references(() => stripeSubscriptions.id, { onDelete: 'cascade' }),
    /**
     * L'instant de l'**observation**, pas de l'écriture — `event.created`.
     *
     * C'est ce qui rend la série honnête quand les webhooks arrivent dans le
     * désordre, et c'est aussi ce qui la rend lisible après un rattrapage : une
     * resynchronisation date ses révisions du moment où elle a lu, pas du moment
     * où le changement a eu lieu chez Stripe, qu'on ignore.
     */
    observedAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /** La devise de l'abonnement. Elle sépare les séries, jamais ne les mélange. */
    currency: text().notNull(),
    /**
     * Le montant mensuel **avant**, en centimes. `null` = il n'y avait rien.
     *
     * `null` et `0` ne disent pas la même chose : le premier est une entrée dans
     * la série — un abonnement qui commence — le second un abonnement qui
     * existait sans rien valoir. Les confondre ferait passer chaque création
     * pour une reprise.
     */
    monthlyBefore: integer(),
    /** Le montant mensuel **après**, en centimes. Zéro sur une résiliation. */
    monthlyAfter: integer().notNull(),
    /**
     * Le statut après le changement, recopié tel quel.
     *
     * Rangé ici plutôt que déduit parce que la lecture n'a pas encore tranché ce
     * qu'elle compte : un `trialing` porte un montant sans avoir rien encaissé,
     * et les deux réponses — le compter ou non — sont défendables. Le stocker
     * laisse ce choix ouvert.
     */
    status: text().notNull(),
    recordedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // La série se lit par projet et dans le temps : c'est le seul accès prévu.
    index('stripe_subscription_revisions_project_observed_idx').on(
      table.projectId,
      table.observedAt,
    ),
  ],
);

export type StripeSubscriptionRevision =
  typeof stripeSubscriptionRevisions.$inferSelect;

import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { projects } from './projects';

/**
 * Le lien entre un client Stripe et le visiteur qui l'a produit.
 *
 * ## Pourquoi il est retenu plutôt que redemandé
 *
 * La première version interrogeait Stripe à chaque événement pour lire la
 * metadata du client. C'était lent, et surtout **faux au pire moment** : un site
 * pose l'identifiant sur le client *après* le checkout, or les webhooks du
 * paiement arrivent avant. On lisait un client encore vide, deux secondes trop
 * tôt, et le paiement — celui qui compte — repartait non attribué pendant que
 * les événements sans intérêt, eux, étaient rattachés.
 *
 * Retenir la paire renverse le problème : l'ordre d'arrivée n'a plus
 * d'importance, et ce qui a été écrit avant peut être rattrapé après.
 *
 * ## L'identifiant est stocké **brut**
 *
 * C'est le seul endroit de la base où il l'est, et c'est délibéré : ce n'est pas
 * une identité de visiteur au sens du socle, c'est ce qu'un site nous a dit de
 * son client. Le socle en dérivera la clé quand il attribuera, comme il le fait
 * à l'ingestion — deux chemins qui dériveraient différemment seraient pires que
 * pas d'attribution du tout.
 *
 * ## Une paire par projet
 *
 * `unique(projectId, customerId)`. Le même `cus_…` chez deux projets n'a rien à
 * voir avec lui-même : les projets ne partagent ni leurs visiteurs ni leurs
 * comptes de paiement. Réapprendre une paire la remplace — un client peut avoir
 * été réattribué, et la dernière affirmation du site fait foi.
 */
export const stripeCustomers = pgTable(
  'stripe_customers',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    customerId: text().notNull(),
    /** L'identifiant durable du visiteur, tel que le site nous l'a donné. */
    visitorId: text().notNull(),
    learnedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.projectId, table.customerId)],
);

export type StripeCustomer = typeof stripeCustomers.$inferSelect;

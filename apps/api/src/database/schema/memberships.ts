import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from './organizations';
import { users } from './users';

/**
 * L'appartenance d'un utilisateur à une organisation, et son rôle dedans.
 *
 * C'est **la table que lit le guard d'accès** : « existe-t-il une ligne liant
 * cet utilisateur à l'organisation qui possède ce projet ». Toute l'autorisation
 * du hub tient dans cette jointure.
 *
 * ## Les rôles
 *
 * `owner`, `admin`, `member` — ceux du plugin, avec `creatorRole: 'owner'`.
 * Aujourd'hui **aucune route ne les distingue** : être membre suffit pour lire
 * les analytics et créer un projet. Ils sont persistés parce que la
 * différenciation viendra (qui peut inviter, qui peut supprimer l'org), et
 * qu'ajouter la colonne après coup coûterait une migration sur des lignes
 * existantes.
 *
 * Ne pas conclure de la présence de cette colonne qu'elle protège quoi que ce
 * soit : à ce stade elle décrit, elle n'autorise pas.
 *
 * ## `cascade` des deux côtés
 *
 * Une appartenance n'a aucun sens sans son utilisateur ni sans son
 * organisation — c'est une ligne de jointure, pas une donnée. Elle disparaît
 * avec l'un ou l'autre. C'est le même raisonnement que pour `accounts`, et
 * l'inverse de `projects` → `organizations`, qui est en `restrict` : un projet,
 * lui, porte des données qu'on ne détruit pas par effet de bord.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().notNull().default('member'),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Le guard part toujours d'une org et d'un utilisateur : c'est cet index
    // qui le rend tenable, puisqu'il est interrogé à chaque lecture d'analytics.
    index('memberships_organization_user_idx').on(
      table.organizationId,
      table.userId,
    ),
    index('memberships_user_id_idx').on(table.userId),
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

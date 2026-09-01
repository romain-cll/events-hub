import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from './organizations';

/**
 * Projet propriétaire des événements : c'est l'unité de cloisonnement du hub.
 * Tout `event` appartient à exactement un projet (cf. `events.projectId`).
 *
 * `createdAt` est l'équivalent Drizzle du `@CreateDateColumn` de TypeORM, en
 * plus explicite : il n'existe pas de décorateur magique, on compose
 * `.defaultNow()` (Postgres écrit `now()` lui-même, donc l'horloge de
 * référence est celle de la base, pas celle du process Node) avec
 * `.notNull()`. Même `timestamptz(3)` que `events.occurredAt` : instant
 * absolu, précision bornée à la milliseconde pour rester alignée sur le `Date`
 * JavaScript que renvoie `pg`.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * L'organisation propriétaire — et donc la réponse à « qui a le droit de
     * lire ce projet ».
     *
     * `notNull` : un projet sans organisation ne serait accessible à personne,
     * puisque l'autorisation passe exclusivement par l'appartenance. Ce n'est
     * pas un état dégradé, c'est un état inatteignable, donc la base le refuse.
     *
     * `onDelete: 'restrict'`, comme partout dans le schéma métier : supprimer
     * une organisation qui porte encore des projets échoue plutôt que d'emporter
     * des données d'ingestion en cascade. La suppression d'une org est une
     * décision qui se prend projet par projet.
     */
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  // Lister les projets d'une organisation est la première requête du dashboard.
  (table) => [index('projects_organization_id_idx').on(table.organizationId)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

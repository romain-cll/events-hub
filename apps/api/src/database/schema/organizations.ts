import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Une organisation : le propriétaire des projets, et l'unité d'autorisation.
 *
 * Tout projet appartient à exactement une organisation, et on n'accède à un
 * projet que si on est membre de la sienne (voir `ProjectMemberGuard`). C'est
 * la seule règle d'accès du hub — il n'y a pas de partage de projet à projet ni
 * de permission par utilisateur.
 *
 * Chaque compte reçoit une organisation personnelle à l'inscription, ce qui
 * évite l'état « utilisateur sans org » : il n'existe pas de chemin où un
 * projet n'aurait nulle part où aller.
 *
 * ## Le schéma appartient au plugin `organization` de Better Auth
 *
 * Les noms de champs viennent de lui et ne sont pas négociables. La table est
 * écrite ici à la main — comme `users` et `accounts` — pour deux raisons : nos
 * conventions (`uuid`, `timestamptz(3)`), et surtout parce que le guard doit
 * pouvoir joindre `memberships` en Drizzle directement, sans passer par
 * `auth.api`.
 *
 * ## `slug` : présent, unique, et inutilisé
 *
 * Le plugin l'exige (`required` + `unique`). On le génère à partir du nom, avec
 * un suffixe aléatoire pour éviter les collisions sans boucle de retry.
 *
 * **Il n'apparaît dans aucune URL et ne doit pas y apparaître.** Les routes
 * sont `/v1/projects/:id` : l'organisation se déduit du projet, et l'accès se
 * vérifie contre l'appartenance — jamais contre un segment d'URL. Construire
 * une route à partir de ce slug reviendrait à exposer une seconde façon de
 * désigner une org, qu'il faudrait alors sécuriser aussi.
 */
export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  /** Sac libre du plugin, sérialisé en chaîne. On n'y range rien. */
  metadata: text(),
  createdAt: timestamp({ withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

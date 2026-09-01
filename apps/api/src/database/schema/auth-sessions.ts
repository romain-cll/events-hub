import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * La session de connexion d'un utilisateur du dashboard.
 *
 * ## À ne pas confondre avec `sessions`
 *
 * Le hub porte deux objets qui s'appellent « session », et ils n'ont rien à voir :
 *
 * - **`sessions`** — la suite d'événements d'un *visiteur anonyme* sur un site
 *   client, sans trou de plus de trente minutes. C'est un concept du domaine,
 *   l'unité de mesure de l'audience. Voir `schema/sessions.ts` ;
 * - **`auth_sessions`** — la présente table : un porteur de jeton qui prouve
 *   qu'une personne s'est connectée. C'est de la plomberie.
 *
 * C'est la table d'auth qui porte le qualificatif, et pas l'inverse, parce que
 * dans cette base de code « session » sans qualificatif désigne déjà la session
 * visiteur. Quand deux choses partagent un nom, on qualifie la moins centrale.
 *
 * Le schéma est celui de Better Auth : les noms de colonnes ne sont pas
 * négociables, l'adaptateur les lit par leur nom.
 *
 * `token` est unique et porte le secret de session — c'est lui que le cookie
 * transporte. Il ne sort jamais d'ici autrement que par `auth.api.getSession()`.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /**
     * IP et User-Agent de la connexion, à des fins d'affichage (« vos sessions
     * actives »). Rien à voir avec la clé visiteur de `sessions`, qui est un
     * HMAC quotidien et ne conserve jamais l'IP en clair : ici la personne est
     * identifiée et consentante, là elle est anonyme.
     */
    ipAddress: text(),
    userAgent: text(),
    /**
     * Ajoutée par le plugin `organization` de Better Auth, et **inutilisée ici**.
     *
     * Le plugin propose une notion d'« organisation active » portée par la
     * session. Notre autorisation ne s'en sert pas : elle est **par chemin** —
     * « cet utilisateur appartient-il à l'organisation qui possède le projet
     * `:projectId` de l'URL » — et se vérifie contre `memberships`, pas contre
     * un état de session.
     *
     * La colonne existe parce que l'adaptateur écrit dedans ; sans elle, il
     * viserait une colonne absente. Ne rien y accuser de protéger quoi que ce
     * soit : une session peut la porter à n'importe quelle valeur sans que ça
     * change le moindre accès.
     */
    activeOrganizationId: uuid(),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('auth_sessions_user_id_idx').on(table.userId)],
);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;

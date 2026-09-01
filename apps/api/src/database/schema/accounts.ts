import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * Un moyen de se connecter, rattaché à un utilisateur.
 *
 * C'est la table qui rend le modèle extensible sans migration. Un utilisateur
 * inscrit par email a une ligne `providerId: 'credential'` portant le hash de
 * son mot de passe ; le jour où il lie GitHub, une seconde ligne apparaît avec
 * ses jetons OAuth. Le compte n'est pas l'identité — l'identité est `users`, et
 * plusieurs façons d'y accéder cohabitent ici.
 *
 * L'unicité porte sur `(issuer, accountId)` : le même identifiant chez deux
 * fournisseurs différents désigne deux comptes distincts.
 *
 * ## Ce qui n'a pas sa place ici
 *
 * Une connexion Stripe, ou toute autre source de données branchée pour
 * enrichir un projet. Ça y ressemble — des jetons OAuth, un `accessToken` à
 * rafraîchir — mais ce n'est pas une identité : ça appartient à l'organisation
 * ou au projet, pas à la personne qui l'a branchée, et ça doit survivre à son
 * départ. Cette table est clé sur `userId` avec un `onDelete: 'cascade'` :
 * y ranger une intégration reviendrait à la perdre le jour où ce membre s'en va.
 *
 * ## `cascade`, à rebours du reste du schéma
 *
 * Ailleurs on utilise `restrict` — supprimer un projet qui porte des événements
 * échoue, parce que détruire des données d'ingestion en cascade est un effet de
 * bord qu'on ne veut pas. Ici c'est l'inverse et c'est délibéré : un moyen de
 * connexion n'a aucune valeur indépendamment de son utilisateur. Supprimer un
 * compte doit emporter sa plomberie ; on ne laisse pas des jetons OAuth
 * orphelins derrière soi.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Le fournisseur, tel que Better Auth l'identifie. */
    issuer: text().notNull(),
    /** L'identifiant du compte *chez le fournisseur*. */
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, precision: 3 }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, precision: 3 }),
    scope: text(),
    /** Hash du mot de passe, uniquement pour `providerId: 'credential'`. */
    password: text(),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('accounts_issuer_account_id_key').on(table.issuer, table.accountId),
    // Postgres n'indexe pas la colonne portante d'une clé étrangère. Toute
    // connexion résout les comptes d'un utilisateur : l'index est explicite.
    index('accounts_user_id_idx').on(table.userId),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

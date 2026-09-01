import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Un utilisateur du dashboard.
 *
 * À ne pas confondre avec un **visiteur** : le visiteur est anonyme, n'a pas de
 * compte, et n'existe dans le hub que sous la forme d'une clé HMAC quotidienne
 * portée par `sessions`. Un `user` est quelqu'un qui se connecte pour *lire* des
 * analytics. Les deux notions ne se croisent jamais.
 *
 * ## Le schéma est dicté par Better Auth
 *
 * Les noms de colonnes ne sont pas négociables : l'adaptateur Drizzle lit et
 * écrit ces champs par leur nom. La table est écrite à la main plutôt que
 * générée par le CLI pour rester cohérente avec le reste du schéma — `uuid()`
 * plutôt que `text()`, `timestamptz(3)` plutôt que `timestamp`, et des
 * commentaires — mais les *noms* viennent de `getAuthTables()` et doivent y
 * rester fidèles.
 *
 * `emailVerified` est un **booléen**, pas une date. C'est la forme qu'attend
 * Better Auth ; en faire un `verifiedAt` nullable serait plus informatif mais
 * l'adaptateur ne saurait pas le lire.
 *
 * ## Ce qui n'est pas ici : le mot de passe
 *
 * Il vit sur `accounts`, avec `providerId: 'credential'`. C'est ce qui rend le
 * modèle prêt pour GitHub ou Google sans migration : un utilisateur connecté
 * uniquement par OAuth n'a simplement pas de ligne portant un mot de passe, au
 * lieu d'une colonne nullable sur cette table qui ferait semblant d'en avoir un.
 */
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp({ withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
  // Better Auth écrit lui-même cette colonne à chaque mise à jour (`onUpdate`
  // dans sa définition de table). Pas de trigger côté base : deux horloges qui
  // écriraient la même colonne finiraient par diverger.
  updatedAt: timestamp({ withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

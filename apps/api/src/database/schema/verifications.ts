import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Les jetons à usage unique de Better Auth : vérification d'adresse email,
 * réinitialisation de mot de passe, confirmation de suppression de compte.
 *
 * `identifier` dit à quoi le jeton se rapporte (une adresse, un identifiant
 * d'utilisateur selon le flux) et `value` porte le jeton lui-même. La table est
 * volontairement générique : c'est Better Auth qui décide ce qu'il y range, et
 * lui seul la lit.
 *
 * Pas de clé étrangère vers `users` : un jeton de vérification d'email peut
 * exister avant que le compte correspondant n'existe.
 *
 * Les lignes expirent (`expiresAt`) mais ne sont pas purgées par une tâche de
 * fond aujourd'hui — Better Auth nettoie les jetons qu'il consomme, et le
 * résidu est borné par le trafic d'inscription. Le jour où il ne le sera plus,
 * c'est ici qu'il faudra brancher un balayage.
 */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;

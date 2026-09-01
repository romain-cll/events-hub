import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from './organizations';
import { users } from './users';

/**
 * Une invitation à rejoindre une organisation, en attente de réponse.
 *
 * ## Clé sur une adresse, pas sur un utilisateur
 *
 * `email` et non `userId` : on invite très souvent quelqu'un qui n'a pas encore
 * de compte. C'est l'acceptation qui crée l'appartenance, et elle peut passer
 * par une inscription intermédiaire. Une clé étrangère vers `users` rendrait ce
 * cas — le plus courant — impossible à représenter.
 *
 * ## Ce qui est géré par le plugin, et pourquoi on le lui laisse
 *
 * Les transitions d'état (`pending` → `accepted` / `rejected` / `canceled`),
 * l'expiration, le refus de rejouer une invitation déjà consommée, et la
 * réponse uniforme qui évite qu'un attaquant énumère les adresses ayant un
 * compte. C'est la partie du chantier la plus facile à rater sans que ça se
 * voie, et c'est la raison pour laquelle on utilise le plugin plutôt que
 * d'écrire ces trois tables nous-mêmes.
 *
 * Cette table est donc déclarée ici pour que Drizzle et les migrations la
 * connaissent — pas pour qu'on écrive dedans.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text(),
    status: text().notNull().default('pending'),
    expiresAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    inviterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('invitations_organization_id_idx').on(table.organizationId),
    index('invitations_email_idx').on(table.email),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

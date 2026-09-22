import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';

/** Les fournisseurs qu'on sait brancher. Inventés par nous, donc fermés. */
export type IntegrationProvider = 'stripe';

/**
 * Une source de données externe branchée sur un projet.
 *
 * ## Pourquoi pas `accounts`
 *
 * Ça y ressemble — un fournisseur, un identifiant chez lui, un flux OAuth — et
 * `accounts` le dit déjà elle-même : ce n'est pas une identité. Elle est clé sur
 * `userId` avec un `onDelete: 'cascade'`, donc y ranger une intégration
 * reviendrait à la perdre le jour où le membre qui l'a branchée quitte
 * l'organisation. Une connexion appartient au **projet**, pas à la personne.
 *
 * ## Il n'y a aucun secret ici, et ce n'est pas un oubli
 *
 * On aurait pu s'attendre à un jeton d'accès chiffré. Stripe Connect n'en
 * demande pas : l'échange OAuth rend un identifiant de compte (`acct_…`), et les
 * appels se font ensuite avec **notre** clé plateforme plus l'en-tête
 * `Stripe-Account`. Ce qui est stocké ici n'ouvre donc rien tout seul — un vol
 * de cette table ne donne accès à aucun compte client.
 *
 * C'est aussi ce qui rend la table réutilisable pour le fournisseur suivant sans
 * se poser la question du chiffrement au repos : si l'un d'eux exige un jeton,
 * c'est **là** qu'il faudra rouvrir le sujet, pas avant.
 *
 * ## Une seule connexion par fournisseur et par projet
 *
 * `unique(projectId, provider)`. Deux comptes Stripe sur un même projet
 * mélangeraient deux comptabilités dans les mêmes compteurs sans qu'aucune
 * lecture ne puisse les démêler — le revenu d'un projet doit venir d'un endroit.
 * Rebrancher un autre compte remplace, et ça se voit.
 *
 * Rien n'interdit l'inverse : le même compte Stripe branché sur deux projets. Un
 * éditeur qui suit deux sites avec une seule facturation est un cas légitime.
 *
 * ## `cascade`, comme `accounts` et à rebours des événements
 *
 * Supprimer un projet emporte sa connexion. C'est de la configuration, pas de la
 * donnée d'ingestion : elle n'a aucune valeur indépendamment de son projet, et
 * la garder derrière lui ne laisserait qu'une ligne inutilisable. Les événements,
 * eux, restent en `restrict` — les détruire en cascade est un effet de bord dont
 * on ne veut pas.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text().$type<IntegrationProvider>().notNull(),
    /**
     * L'identifiant du compte chez le fournisseur — un `acct_…` pour Stripe.
     *
     * C'est tout ce qu'il faut pour agir en son nom, en le passant dans
     * `Stripe-Account`. Non secret par lui-même : il ne vaut que présenté avec
     * notre clé plateforme, qui, elle, ne quitte pas l'environnement.
     */
    externalAccountId: text().notNull(),
    /**
     * La portée accordée, telle que le fournisseur l'a rendue.
     *
     * On demande `read_only` et on ne demandera jamais autre chose — mais on
     * enregistre ce qui a été **accordé**, pas ce qui a été demandé. Le jour où
     * les deux divergent, c'est ici qu'on le verra plutôt que de le déduire.
     */
    scope: text().notNull(),
    /**
     * Le compte connecté est-il en production ?
     *
     * Un compte de test et un compte réel se ressemblent en tout point à
     * l'usage. Sans ce drapeau, un projet branché par erreur sur un compte de
     * test afficherait un revenu plausible et faux, et rien ne le signalerait.
     */
    livemode: boolean().notNull(),
    connectedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.projectId, table.provider)],
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;

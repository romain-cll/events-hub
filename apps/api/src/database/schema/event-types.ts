import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';

/**
 * Le vocabulaire d'un projet : un type d'événement, son libellé, et qui a le
 * droit de l'émettre.
 *
 * ## Ce n'est pas un gardien à l'ingestion
 *
 * Un type inconnu n'est **jamais refusé** : il est inscrit ici à la volée, lors
 * de la première ingestion. Refuser aurait été plus strict que PostHog (qui
 * crée ses définitions automatiquement) et que Plausible (qui reçoit l'événement
 * et ne fait que retenir son *affichage*) — pour une protection illusoire.
 * Quiconque détient une clé valide pollue déjà très bien avec un type
 * enregistré : l'isolation entre projets vient de la clé, pas d'une liste de
 * noms. Et un 4xx à l'ingestion, c'est de la donnée perdue par celui qui
 * déploie un nouveau nom un vendredi soir.
 *
 * Ce que la table apporte, et qui justifie son existence, est ailleurs : c'est
 * **le seul endroit où un type peut déclarer qui a le droit de l'émettre**
 * (`serverOnly`), et le seul endroit où il peut porter un nom lisible.
 *
 * ## `name` est immuable, `label` ne l'est pas
 *
 * `name` est la clé technique en `snake_case`, celle qui est écrite sur chaque
 * ligne d'`events` et que les filtres désignent. La laisser changer
 * orphelinerait tout l'historique du projet d'un coup — aucune route ne la
 * modifie, et c'est délibéré.
 *
 * `label` est l'affichage, et lui bouge librement. `null` n'est pas « pas de
 * libellé » mais « jamais nommé » : l'interface retombe alors sur `name`, et la
 * distinction se voit — quelqu'un qui a délibérément saisi le même texte que le
 * nom technique n'est pas dans le même état que quelqu'un qui n'a rien fait.
 *
 * ## `serverOnly` se fait respecter à la lecture
 *
 * Le drapeau n'agit pas à l'écriture. Toute lecture écarte les événements de ce
 * type dont la `source` n'est pas serveur (voir `EventStore.where`).
 *
 * C'est ce qui règle un problème d'ordre autrement insoluble : sans cela, il
 * suffirait de forger un type sensible depuis un navigateur **avant** que le
 * drapeau ne soit posé pour que la donnée fausse reste acquise. Ici, poser le
 * drapeau la fait disparaître rétroactivement, sans migration ni purge, et le
 * retirer la fait revenir. Les lignes forgées restent en base — elles ont
 * consommé du quota, c'est le prix assumé de ne pas détruire de donnée sur un
 * changement de réglage.
 *
 * Il est **opt-in**, jamais un défaut : un client peut vouloir des funnels web
 * sur ses propres types, et un défaut server-only casserait le cas courant pour
 * couvrir le cas rare.
 *
 * ## `onDelete: 'cascade'`
 *
 * À rebours du `restrict` employé pour les données d'ingestion : un nom de type
 * n'a aucune valeur indépendamment de son projet, alors qu'un événement est le
 * produit.
 */
export const eventTypes = pgTable(
  'event_types',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Clé technique en `snake_case`. Immuable — voir plus haut. */
    name: text().notNull(),
    /** Libellé d'affichage. `null` = jamais nommé, l'interface affiche `name`. */
    label: text(),
    serverOnly: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Unicité **par projet**, pas globale : deux clients peuvent nommer
    // `signup` sans se voir. C'est aussi l'index sur lequel s'appuie le
    // `ON CONFLICT DO NOTHING` de l'inscription à la volée.
    unique('event_types_project_name_key').on(table.projectId, table.name),
    index('event_types_project_id_idx').on(table.projectId),
  ],
);

export type EventType = typeof eventTypes.$inferSelect;
export type NewEventType = typeof eventTypes.$inferInsert;

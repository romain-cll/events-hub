import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';
import { sessions } from './sessions';

/**
 * Événement brut ingéré par le hub.
 *
 * `projectId` rattache l'événement à son projet. La contrainte est `notNull` :
 * un événement orphelin ne serait rattachable à rien après coup, donc on
 * refuse l'écriture plutôt que de produire de la donnée non exploitable.
 * `onDelete: 'restrict'` fait échouer la suppression d'un projet qui porte
 * encore des événements — supprimer des données d'ingestion en cascade, sans
 * que personne ne l'ait demandé explicitement, est un effet de bord qu'on ne
 * veut pas par défaut.
 *
 * Postgres n'indexe *pas* automatiquement la colonne portante d'une clé
 * étrangère (seule la cible, la PK, l'est). Comme toute lecture d'événements
 * sera filtrée par projet, l'index est déclaré ici explicitement.
 *
 * `occurredAt` est un `timestamptz(3)` : Postgres stocke un instant absolu
 * (normalisé UTC), pas une chaîne. La précision est bornée à la milliseconde
 * parce que c'est la limite du `Date` JavaScript que renvoie `pg` — laisser la
 * précision par défaut (microseconde) ferait diverger silencieusement ce qui
 * est écrit de ce qui est relu. La sérialisation JSON d'un `Date` produit
 * exactement la forme ISO 8601 UTC attendue (`2026-08-20T14:30:00.000Z`).
 *
 * `attributes` et `properties` sont volontairement libres (jsonb) : leur forme
 * dépend du `type`. Les clés qu'y range le SDK sont pointées
 * (`domaine.champ`), d'où l'accès par chaîne plutôt qu'un type nominal — et
 * nommer ici une clé précise reviendrait déjà à savoir ce qu'elle désigne.
 */
/**
 * D'où un événement est entré dans le hub.
 *
 * Le type vit ici, à côté de la colonne qu'il décrit, parce que les deux côtés
 * en ont besoin sans avoir à se connaître : `ProjectKeysService` le produit
 * depuis la nature de la clé, `CoreService` en tire le chemin d'ingestion.
 * Le faire vivre chez l'un ferait dépendre l'autre de lui pour une union de
 * deux chaînes.
 */
export type EventSource = 'browser' | 'server';

export const events = pgTable(
  'events',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    type: text().notNull(),
    occurredAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /**
     * D'où l'événement est entré : `browser` ou `server`.
     *
     * **Dérivée de la classe de clé présentée à l'ingestion, jamais lue dans le
     * payload.** Une clé publique n'écrit que `browser`, une clé secrète que
     * `server`. C'est ce qui la rend digne de confiance : le client ne la
     * choisit pas, donc il ne peut pas se faire passer pour une source qu'il
     * n'est pas — c'est exactement ce sur quoi repose le drapeau `serverOnly`
     * d'`event_types`.
     *
     * `notNull` sans défaut : tout événement vient de quelque part, et laisser
     * un défaut ferait passer un chemin d'ingestion mal câblé pour du trafic
     * navigateur.
     */
    source: text().$type<EventSource>().notNull(),
    /**
     * La session à laquelle l'événement appartient — la suite d'événements du
     * même visiteur sans trou de plus de trente minutes. Elle est **attribuée à
     * l'ingestion** et persistée : c'est la source de vérité unique du
     * découpage, et aucun module ne la recalcule.
     *
     * ## `null` veut dire quelque chose, ce n'est pas une valeur manquante
     *
     * Un deploy, un webhook de paiement, une sonde d'uptime n'ont **pas de
     * visiteur**. Il n'y a rien à leur attribuer, et leur fabriquer une session
     * depuis l'IP du runner qui les émet produirait une donnée fausse : ce
     * « visiteur » compterait dans les visiteurs uniques du projet.
     *
     * La colonne est donc nullable, et c'est ce qui fait du produit un hub
     * plutôt qu'un outil d'analyse web. Elle porte l'affirmation « cet
     * événement n'a pas de visiteur », qui est vraie et qui le restera.
     *
     * Conséquence à connaître pour les lectures : `COUNT(DISTINCT session_id)`
     * ignore les `NULL` de lui-même, et une jointure interne sur `sessions`
     * écarte ces lignes sans qu'on ait à l'écrire. Les compteurs adossés à la
     * session se filtrent donc **structurellement** — il n'y a rien à ajouter,
     * et surtout rien à retirer le jour où un événement serveur portera une
     * session (un paiement rattaché à une visite, pour un funnel).
     *
     * La clé visiteur, elle, n'est **pas** sur cette table : elle vit sur
     * `sessions` (voir le commentaire de cette table-là). L'identité anonyme est
     * un attribut de la session, pas de chaque événement — un module qui lit des
     * événements ne l'a donc plus sous la main par inadvertance.
     */
    sessionId: uuid().references(() => sessions.id, { onDelete: 'restrict' }),
    attributes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    properties: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index('events_project_id_idx').on(table.projectId),
    // La recherche de voisins lit les événements d'une session autour d'un
    // instant, et la fusion les réécrit par session. Les deux passent par là.
    index('events_session_occurred_idx').on(table.sessionId, table.occurredAt),
    // Toute lecture croise `event_types` pour faire respecter `serverOnly`
    // (voir `EventStore.where`). La corrélation se fait sur ce couple.
    index('events_project_type_idx').on(table.projectId, table.type),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

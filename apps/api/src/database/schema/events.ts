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
     * événement n'a pas de **visite** », qui est vraie et qui le restera.
     *
     * Elle ne dit plus « pas de visiteur » : depuis le lot revenu, un paiement
     * rapporté par un serveur désigne quelqu'un dont on connaît le parcours,
     * sans s'être produit pendant une visite — il peut arriver trois jours après
     * la dernière, ou des mois plus tard pour un renouvellement. C'est
     * `visitorKey`, juste en dessous, qui porte cette seconde question.
     *
     * Conséquence à connaître pour les lectures : `COUNT(DISTINCT session_id)`
     * ignore les `NULL` de lui-même, et une jointure interne sur `sessions`
     * écarte ces lignes sans qu'on ait à l'écrire. Les compteurs adossés à la
     * session se filtrent donc **structurellement** — il n'y a rien à ajouter,
     * et surtout rien à retirer le jour où un événement serveur portera une
     * session (un paiement rattaché à une visite, pour un funnel).
     *
     */
    sessionId: uuid().references(() => sessions.id, { onDelete: 'restrict' }),
    /**
     * L'identité **durable** du visiteur, quand il en a consenti une.
     *
     * ## Pourquoi elle a fini par arriver ici
     *
     * Cette colonne n'existait pas, et le commentaire qui vit ici disait
     * pourquoi : l'identité anonyme est un attribut de la *session*, pas de
     * chaque événement, et l'y remonter la mettrait sous la main de tout module
     * qui lit des événements.
     *
     * Ce qui a changé n'est pas l'intention, c'est le modèle. Un paiement a un
     * visiteur **sans avoir de visite** : il n'a pas de `sessionId`, donc plus
     * rien ne le relierait à un parcours. Sans cette colonne, la seule question
     * que le produit pose — d'où vient ce revenu — n'a pas de réponse.
     *
     * L'intention, elle, tient toujours, mais autrement : c'est `EventStore` qui
     * expose la corrélation, et `architecture.spec.ts` interdit toujours à un
     * module métier de **nommer** cette clé. Aucun d'eux ne l'a sous la main.
     *
     * ## Durable, et rien d'autre
     *
     * Nullable, et elle ne porte **jamais** la clé dérivée du réseau. Celle-ci
     * tourne chaque jour : la figer sur un événement laisserait croire à une
     * continuité qui n'existe pas, et deux visiteurs derrière la même sortie
     * réseau la partagent. Ce qui est écrit ici a été consenti, ou n'est pas
     * écrit.
     *
     * La conséquence est nette et voulue : sans consentement, un paiement n'est
     * corrélable à rien. Ce n'est pas une limite de l'implémentation.
     */
    visitorKey: text(),
    attributes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    properties: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index('events_project_id_idx').on(table.projectId),
    // « Tout ce que ce visiteur a fait », la lecture qui porte l'attribution du
    // revenu. Cloisonnée par projet comme toutes les autres.
    index('events_project_visitor_idx').on(table.projectId, table.visitorKey),
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

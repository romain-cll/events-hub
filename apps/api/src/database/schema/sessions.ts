import {
  char,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';

/**
 * Une session : la suite d'événements d'un même visiteur, sans trou de plus de
 * trente minutes.
 *
 * ## Pourquoi une table, et pas un calcul à la lecture
 *
 * Parce qu'on veut **une seule source de vérité**. Un `session_id` recalculé à
 * chaque requête serait modifiable rétroactivement — changer le seuil
 * reprofilerait tout l'historique — mais il obligerait chaque lecture à refaire
 * le découpage, et deux modules qui interrogeraient avec des paramètres
 * légèrement différents parleraient de sessions différentes sans le savoir.
 *
 * Ici, `COUNT(DISTINCT session_id)` et `GROUP BY session_id` sont des lectures
 * ordinaires, et tous les modules parlent exactement des mêmes sessions.
 *
 * Le prix est assumé : changer la règle des trente minutes demanderait de
 * reconstruire l'historique. On l'accepte parce que trente minutes est une
 * convention stable de l'analyse web, pas un réglage qu'on prévoit de bouger.
 *
 * ## `visitor_key` vit ici, plus sur l'événement
 *
 * C'est la séparation qui donne son sens à cette table : l'**identité technique
 * anonyme** est un attribut de la session, pas de chaque événement. Elle ne sert
 * qu'à une chose — savoir à quelle session rattacher un événement entrant — et
 * elle n'a aucune raison d'être répétée des milliers de fois à côté.
 *
 * Conséquence voulue : un module d'analyse qui lit des événements n'a plus la
 * clé visiteur sous la main par accident. S'il en a besoin, il passe par la
 * session, ce qui rend l'usage visible.
 *
 * `visitor_key` tourne chaque jour UTC (voir `VisitorKeyService`). Une session
 * ne peut donc pas traverser minuit : le visiteur change de clé, et ses
 * événements suivants ouvrent une nouvelle session même s'ils suivent de deux
 * minutes. C'est la borne de confidentialité qui déborde sur le découpage, et
 * c'est assumé.
 *
 * ## `started_at`
 *
 * L'instant du plus ancien événement de la session. Redondant avec les
 * événements — il s'en déduit par un `MIN` — mais il est maintenu ici parce que
 * c'est lui qui départage lors d'une fusion : quand deux sessions se révèlent
 * n'en être qu'une, c'est la plus ancienne qui survit. Le lire sur la session
 * évite d'agréger les événements pour prendre cette décision.
 *
 * Il peut **reculer** : un événement arrivé en retard, antérieur à tout ce qu'on
 * connaissait de la session, avance sa borne de début.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** HMAC quotidien de l'IP et du User-Agent. Ne sort jamais du Core. */
    visitorKey: text().notNull(),
    startedAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    /**
     * ## D'où vient le visiteur — trois colonnes, toutes facultatives
     *
     * Résolues **une fois**, à l'ouverture de la session, depuis l'IP de la
     * requête (voir `GeoIpService`). Elles sont sur la session et pas sur
     * l'événement pour la même raison que `visitor_key` : c'est un attribut du
     * visiteur pendant sa visite, pas de chacun de ses gestes. Un module qui lit
     * des événements ne l'a donc pas sous la main par inadvertance.
     *
     * ⚠️ **L'IP, elle, n'est nulle part.** Elle entre dans `CoreService`, sert à
     * dériver ces trois libellés et la clé visiteur, et meurt avec la requête.
     * C'est ce qui rend la géolocalisation acceptable ici : ce qui est persisté
     * est déjà grossier et non réversible.
     *
     * `null` n'est pas rare et n'est pas une anomalie : base absente, IP privée
     * ou de bouclage, plage inconnue de la base. Toute lecture doit compter les
     * non-résolus plutôt que de les taire.
     */
    countryCode: char({ length: 2 }),
    /**
     * Le nom du premier niveau de subdivision, pas un code.
     *
     * DB-IP City Lite n'en porte pas : ses `subdivisions[0]` n'ont qu'un
     * `names`. Un `regionCode` serait donc vide aujourd'hui, et une colonne
     * toujours nulle est une promesse qu'on ne tient pas.
     */
    region: text(),
    city: text(),
  },
  (table) => [
    // La recherche de voisins part toujours d'un projet et d'une clé visiteur :
    // c'est l'index qui rend l'ingestion tenable, puisqu'elle interroge cette
    // table à chaque événement.
    index('sessions_project_visitor_idx').on(table.projectId, table.visitorKey),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

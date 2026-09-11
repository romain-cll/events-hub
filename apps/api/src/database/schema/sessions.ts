import {
  boolean,
  char,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import type { DeviceType } from '../../user-agent/user-agent.service';
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
    /**
     * ## Avec quoi il navigue — trois libellés et un drapeau
     *
     * Dérivés du User-Agent à l'ouverture de la session, exactement comme les
     * trois colonnes géographiques le sont de l'IP, et pour les mêmes raisons :
     * c'est un attribut de la visite, pas de chacun de ses gestes.
     *
     * ⚠️ **Le User-Agent, lui, n'est nulle part.** Il entre dans `CoreService`,
     * sert à dériver ces libellés et la clé visiteur, et meurt avec la requête.
     * Aucune version n'est conservée : la mineure est du bruit qui multiplie
     * l'unicité, et celle du système est carrément fausse — Windows 11 se
     * déclare « Windows NT 10.0 », macOS « 10_15_7 » depuis des années. Voir
     * `UserAgentService` pour le détail de ce qui est écarté et pourquoi.
     *
     * `null` est le cas normal de la longue traîne : un navigateur qu'on ne sait
     * pas nommer. Les lectures le comptent plutôt que de le taire.
     *
     * ⚠️ **Les tablettes sont sous-comptées, et c'est irrécupérable.** Depuis
     * iPadOS 13, Safari envoie par défaut l'en-tête d'un Mac : la majorité des
     * iPad est rangée en `desktop`. L'information n'est pas dans la chaîne.
     */
    browser: text(),
    os: text(),
    deviceType: text().$type<DeviceType>(),
    /**
     * Un robot **qui s'est déclaré**, jamais un visiteur qu'on a jugé suspect.
     *
     * `NOT NULL DEFAULT false`, et le défaut est permanent plutôt qu'un
     * échafaudage de migration : une session dont le client n'est pas
     * identifiable n'est pas un robot, aujourd'hui comme demain.
     *
     * Les lectures l'écartent structurellement — la condition vit dans
     * `EventStore.where()`, que toutes traversent — mais jamais en silence : le
     * résumé publie le nombre de sessions ainsi retirées. Un chiffre jeté sans
     * le dire est un chiffre que personne ne sait manquant.
     */
    isBot: boolean().notNull().default(false),
    /**
     * ## Quelle campagne a amené la visite — trois colonnes, toutes facultatives
     *
     * Extraites de l'URL par le SDK, normalisées par le serveur
     * (`normalizeCampaign`), et posées **à l'ouverture de la session seulement**.
     *
     * Par événement, une visite de trois pages dirait trois arrivées de la même
     * campagne : les UTM restent dans l'URL après le premier chargement. L'erreur
     * serait proportionnelle à la profondeur des visites — invisible, et d'autant
     * plus grosse que le site est bon.
     *
     * **Minuscules**, parce que `Newsletter` et `newsletter` sont la même
     * campagne et que personne ne le dirait à un classement qui les sépare. Le
     * prix est un libellé en minuscules à l'affichage.
     *
     * ⚠️ **Ce que le serveur garantit ici, et ce qu'il ne garantit pas.** Il
     * garantit la normalisation, le moment où la valeur est figée, et sa
     * joignabilité. Il ne garantit **pas** que ces paramètres étaient dans la
     * barre d'adresse : le SDK pourrait les inventer, comme il pourrait déjà
     * inventer l'URL entière. La promesse est de forme et de moment, pas de
     * provenance.
     *
     * Les deux autres paramètres de campagne — terme et contenu — ne sont pas
     * ici : ils répondent à « quelle création », pas à « quelle campagne
     * rapporte ». Ils restent entiers dans l'URL que le sac d'attributs
     * transporte, et deux colonnes presque toujours nulles ne valent pas leur
     * place.
     */
    campaignSource: text(),
    campaignMedium: text(),
    campaignName: text(),
  },
  (table) => [
    // La recherche de voisins part toujours d'un projet et d'une clé visiteur :
    // c'est l'index qui rend l'ingestion tenable, puisqu'elle interroge cette
    // table à chaque événement.
    index('sessions_project_visitor_idx').on(table.projectId, table.visitorKey),
    // « Quelle campagne a amené quoi », la lecture qui porte l'acquisition
    // payante. Cloisonnée par projet comme toutes les autres.
    index('sessions_project_campaign_idx').on(
      table.projectId,
      table.campaignSource,
    ),
    // Le seul index **non cloisonné par projet** de la table, et c'est voulu :
    // la purge balaie la plateforme, précisément pour qu'aucun projet ne puisse
    // y échapper. Elle parcourt cette table de la plus ancienne visite à la plus
    // récente et s'arrête à la borne de rétention — sans cet index, elle lirait
    // toute la table chaque nuit pour découvrir qu'il n'y a rien à faire.
    index('sessions_started_at_idx').on(table.startedAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

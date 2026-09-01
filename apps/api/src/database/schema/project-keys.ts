import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';

/**
 * Une clé d'ingestion : ce que le SDK présente pour dire à quel projet ses
 * événements appartiennent.
 *
 * ## Elle n'est pas un secret, et on n'essaie pas de le faire croire
 *
 * Le SDK tourne dans le navigateur des visiteurs d'un site client : la clé est
 * en clair dans le bundle, lisible par n'importe qui ouvre les outils de
 * développement. C'est le même statut qu'un DSN Sentry ou qu'une clé
 * publiable Stripe — **un identifiant de routage**, pas une authentification.
 *
 * Conséquence directe sur cette table : la valeur d'une clé **publique** est
 * stockée **en clair**. Le réflexe « un identifiant secret se hache » est faux
 * pour elle, deux fois plutôt qu'une — il faut la retrouver *par sa valeur* à
 * chaque événement, donc par un hash déterministe sans sel qui ne protégerait
 * presque rien, et elle est de toute façon publiée à chaque chargement de page.
 *
 * ## La clé serveur, elle, est hachée
 *
 * `eh_sk_` ne vit pas dans un bundle : elle est un vrai secret, détenue par le
 * backend d'un client. Elle est donc **hachée en base** et n'est rendue en clair
 * qu'une fois, à la création. La retrouver reste possible sans la stocker : le
 * hash est déterministe, donc la résolution cherche `hash(valeur présentée)`.
 * Ce qui est acceptable ici et ne l'était pas là-haut, c'est que le secret n'est
 * pas publié — un vol de base ne rend pas les clés utilisables.
 *
 * Le préfixe dit laquelle des deux on tient **avant toute requête**, ce qui
 * décide de la colonne à interroger. Les deux natures cohabitent donc dans cette
 * table, discriminées par `isSecret`.
 *
 * ## `allowedOrigins` n'est pas une mesure de sécurité
 *
 * Il faut le dire ici parce que c'est le fichier où on serait tenté de le
 * croire. `curl -H 'Origin: https://client.com'` passe l'allowlist sans
 * difficulté : l'en-tête est posé par le navigateur, et un appelant qui n'en
 * est pas un met ce qu'il veut.
 *
 * Ce que la liste arrête réellement, c'est le cas **fréquent et accidentel** :
 * un snippet copié sur un autre site, un environnement de staging, un template
 * forké, qui déversent leurs vrais visiteurs dans le projet. Là c'est bien un
 * navigateur qui émet, et un navigateur ne peut pas forger `Origin`. C'est de
 * l'**hygiène de données**, et ça doit se présenter comme telle jusque dans
 * l'interface — quelqu'un qui la lirait comme une protection se croirait à
 * l'abri de ce qu'elle ne couvre pas.
 *
 * La seule protection réelle contre la pollution est un plafond d'ingestion par
 * projet. Il n'existe pas encore.
 *
 * ## Ce que cette table permet et qui compte
 *
 * Plusieurs clés par projet, et une révocation qui **ne supprime pas la ligne**
 * (`revokedAt`). C'est ce qui rend la rotation possible sans coupure : on crée
 * une seconde clé, on migre les sites à leur rythme, on révoque la première —
 * au lieu de casser tous les clients déployés d'un coup.
 *
 * `onDelete: 'cascade'` vers `projects`, à rebours du `restrict` employé pour
 * les données d'ingestion : une clé n'a aucune valeur indépendamment de son
 * projet, alors qu'un événement est le produit.
 */
export const projectKeys = pgTable(
  'project_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * `eh_pk_` ou `eh_sk_`, suivi de 32 caractères hexadécimaux.
     *
     * Pour une clé publique, c'est la valeur elle-même. Pour une clé serveur,
     * c'est son **hash** : la valeur en clair n'est jamais réécrite ici après
     * la création.
     *
     * Le préfixe n'est pas décoratif : il rend la clé reconnaissable dans un
     * bundle ou un log, et il distingue `eh_pk_` de `eh_sk_` à l'œil comme au
     * code — c'est lui qui dit s'il faut chercher en clair ou par hash.
     */
    value: text().notNull().unique(),
    /**
     * Vraie pour une clé serveur (`eh_sk_`), fausse pour une clé publique
     * (`eh_pk_`).
     *
     * Un booléen plutôt qu'une énumération : les deux natures se déduisent
     * l'une de l'autre, et un défaut à `false` dit la bonne chose — une clé est
     * publique sauf mention contraire, et c'est le **privilège** qu'on coche.
     * L'inverse aurait fait d'un oubli une clé trop puissante.
     *
     * Il ne s'appelle pas `type` : le mot était déjà pris par `events.type` et
     * par la table `event_types`, qui ne parlent ni l'un ni l'autre de la même
     * chose. Trois « type » dans le même schéma, c'est une confusion qui finit
     * par coûter un bug.
     */
    isSecret: boolean().notNull().default(false),
    /**
     * Origines autorisées, comparées **à l'identique** : schéma, hôte et port.
     *
     * Pas de comparaison par sous-chaîne, qui laisserait passer
     * `https://acme.com.evil.io` pour `https://acme.com`. Les jokers de
     * sous-domaine (`*.acme.com`) ne sont pas gérés ; les ajouter changera la
     * fonction de correspondance, pas cette colonne.
     *
     * Jamais vide : une clé sans origine déclarée n'apporterait rien à ceux qui
     * ne la configurent pas, c'est-à-dire à la majorité.
     *
     * Une origine qui ne figure pas ici ne provoque **aucune erreur visible** :
     * `POST /v1/events` rend 204 sans corps et n'écrit rien. Le refus n'existe
     * que dans les journaux du serveur — c'est ce qu'il faudra exposer dans
     * l'UI pour que la configuration reste diagnosticable.
     */
    allowedOrigins: text().array().notNull(),
    /** Libellé humain — « prod », « staging ». Sans effet sur la validation. */
    name: text(),
    /** Non nul = révoquée. La ligne reste, pour que l'historique reste lisible. */
    revokedAt: timestamp({ withTimezone: true, precision: 3 }),
    createdAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Lister les clés d'un projet est la requête de l'écran de configuration.
    // La résolution à l'ingestion, elle, passe par l'index unique de `value`.
    index('project_keys_project_id_idx').on(table.projectId),
  ],
);

export type ProjectKey = typeof projectKeys.$inferSelect;
export type NewProjectKey = typeof projectKeys.$inferInsert;

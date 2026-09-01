import { z } from 'zod';

/**
 * Les projets et leurs clés d'ingestion.
 *
 * ## Les objets ne sont pas stricts, et c'est un choix
 *
 * Un champ inconnu est **ignoré**, pas refusé. C'est ce qui distingue les deux
 * façons dont un contrat peut bouger :
 *
 * - un champ **disparaît ou change de nom** — quelqu'un le lisait, il ne le
 *   lira plus : la validation échoue, et c'est ce qu'on veut ;
 * - un champ **apparaît** — personne ne le lit encore : refuser la réponse
 *   casserait tous les clients déployés à chaque ajout côté serveur.
 *
 * Un contrat strict rendrait l'API impossible à faire évoluer sans déployer les
 * deux côtés à la seconde près.
 */

/**
 * Un projet, tel que `GET /v1/projects` et `POST /v1/projects` le rendent.
 *
 * `organizationName` est joint côté serveur : le dashboard affiche le projet
 * avec son organisation sans avoir à recouper deux listes.
 */
export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Sérialisé depuis un `Date` — ISO 8601 avec décalage. */
  createdAt: z.iso.datetime({ offset: true }),
  organizationId: z.uuid(),
  organizationName: z.string(),
});

export type Project = z.infer<typeof projectSchema>;

export const projectsSchema = z.array(projectSchema);

/**
 * Une clé d'ingestion, rendue par les quatre routes `/v1/projects/:id/keys`.
 *
 * ## `value` est en clair pour une clé publique, et `null` pour une clé serveur
 *
 * La clé publique vit dans le bundle de chaque page cliente : elle identifie et
 * route, elle n'authentifie pas. La rendre au propriétaire du projet ne révèle
 * rien qu'un `view-source` ne montrerait.
 *
 * La clé serveur, elle, est un vrai secret : la base n'en garde qu'un hash, et
 * `value` ne la porte **qu'une fois**, dans la réponse à sa création. Toute
 * lecture ultérieure rend `null`, qui dit la bonne chose — cette valeur ne se
 * retrouve pas. Rendre le hash aurait laissé croire à un secret récupérable.
 *
 * ## `revokedAt` plutôt qu'un booléen
 *
 * Révoquer ne supprime pas : la ligne reste, datée, pour que l'historique reste
 * lisible. `null` veut dire « active ».
 */
export const projectKeySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  value: z.string().nullable(),
  /**
   * Vraie pour une clé serveur (`eh_sk_`), fausse pour une clé publique
   * (`eh_pk_`).
   *
   * Un booléen plutôt qu'une chaîne de nature : les deux cas se déduisent l'un
   * de l'autre, et l'écran n'a qu'une question à poser. C'est aussi lui qui dit
   * si `value` sera là — une clé secrète la rend `null` partout sauf à sa
   * création.
   */
  isSecret: z.boolean(),
  /** Comparées à l'identique — schéma, hôte et port. Jamais vide. */
  allowedOrigins: z.array(z.string()),
  /** Libellé humain (« prod », « staging »), ou `null`. */
  name: z.string().nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type ProjectKey = z.infer<typeof projectKeySchema>;

export const projectKeysSchema = z.array(projectKeySchema);

/**
 * `GET /v1/projects/:projectId/ingestion` — « est-ce que ça arrive ? ».
 *
 * Un seul booléen, et c'est délibéré. La question posée pendant l'installation
 * n'est pas « combien » mais « est-ce branché ». Côté serveur elle se répond par
 * une **existence** — un parcours d'index qui s'arrête à la première ligne — là
 * où un agrégat coûterait de plus en plus cher à mesure que le projet vit. C'est
 * ce qui rend la route interrogeable toutes les trois secondes sans y penser.
 *
 * Elle n'est donc pas une route analytique au rabais : `/analytics` répond déjà
 * « combien », sur une fenêtre, et pour un tout autre prix. Les confondre
 * ferait payer un résumé complet à chaque battement d'un écran d'attente.
 */
export const projectIngestionSchema = z.object({
  hasEvents: z.boolean(),
});

export type ProjectIngestion = z.infer<typeof projectIngestionSchema>;

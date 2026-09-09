import { z } from 'zod';

/**
 * Les sources de données branchées sur un projet.
 *
 * ## Ce que la forme ne contient pas
 *
 * Aucun secret, et il n'y en a pas à cacher : Stripe Connect ne rend pas de
 * jeton à conserver. Ce que le dashboard reçoit est un identifiant de compte,
 * qui ne vaut rien sans la clé plateforme — laquelle ne quitte jamais le
 * serveur. C'est ce qui permet d'afficher la connexion sans avoir à masquer
 * quoi que ce soit.
 */

/**
 * Le fournisseur, en **énumération** là où `type` d'un événement est une chaîne
 * libre — et la différence est la même qu'entre `type` et `source` : les types
 * sont inventés par les clients, les fournisseurs par nous. En ajouter un est
 * notre propre déploiement, celui-là même où ce fichier changerait.
 */
export const integrationProviderSchema = z.enum(['stripe']);

export const integrationSchema = z.object({
  provider: integrationProviderSchema,
  /**
   * L'identifiant du compte chez le fournisseur — un `acct_…` pour Stripe.
   *
   * Affiché tel quel : c'est ce qui permet à quelqu'un de vérifier qu'il a
   * branché le bon compte, question qui n'a l'air de rien jusqu'à ce que le
   * revenu affiché soit celui d'une autre entité juridique.
   */
  externalAccountId: z.string(),
  /**
   * La portée accordée par le fournisseur.
   *
   * Rendue parce qu'elle se montre : « read_only » à l'écran est la seule façon
   * pour un client de constater qu'on ne peut rien écrire chez lui, plutôt que
   * de devoir nous croire sur parole.
   */
  scope: z.string(),
  /**
   * Le compte est-il en production ?
   *
   * Un compte de test et un compte réel se ressemblent en tout point à l'usage.
   * Sans ce drapeau à l'écran, un projet branché par erreur sur un compte de
   * test afficherait un revenu plausible et faux.
   */
  livemode: z.boolean(),
  /** Sérialisé depuis un `Date` — ISO 8601 avec décalage. */
  connectedAt: z.iso.datetime({ offset: true }),
});

export type Integration = z.infer<typeof integrationSchema>;

export const integrationsSchema = z.array(integrationSchema);

/** Ce que rend la demande d'autorisation : où envoyer le membre. */
export const integrationAuthorizationSchema = z.object({ url: z.url() });

export type IntegrationAuthorization = z.infer<
  typeof integrationAuthorizationSchema
>;

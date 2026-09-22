import {
  integrationAuthorizationSchema,
  integrationSchema,
  integrationsSchema,
  type Integration,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson, write } from './api';

export type { Integration };

/**
 * Les sources branchées sur un projet.
 *
 * Lisible par tout membre, à la différence des trois écritures qui suivent :
 * savoir d'où vient le revenu affiché fait partie de la lecture ordinaire ;
 * brancher un compte de paiement, non.
 */
export function integrationsQuery(projectId: string) {
  return queryOptions({
    queryKey: ['projects', projectId, 'integrations'],
    queryFn: () =>
      apiJson(`/v1/projects/${projectId}/integrations`, integrationsSchema),
  });
}

/**
 * Demande l'URL vers laquelle envoyer le membre pour autoriser le hub.
 *
 * Une écriture au sens HTTP alors que rien n'est enregistré : l'URL porte un
 * jeton d'état signé à durée de vie courte, donc chaque appel produit une valeur
 * différente et aucune ne doit être mise en cache.
 */
export function authorizeStripe(projectId: string) {
  return write(
    `/v1/projects/${projectId}/integrations/stripe/authorize`,
    integrationAuthorizationSchema,
  );
}

/**
 * Termine la connexion avec ce que Stripe a renvoyé dans l'URL de retour.
 *
 * Le `code` ne vaut qu'une fois et le `state` quinze minutes : ce sont eux qui
 * empêchent qu'on fasse brancher à quelqu'un le compte d'un autre. L'API les
 * vérifie, le dashboard ne fait que les relayer.
 */
export function completeStripe(
  projectId: string,
  body: { code: string; state: string },
): Promise<Integration> {
  return write(
    `/v1/projects/${projectId}/integrations/stripe/callback`,
    integrationSchema,
    body,
  );
}

/**
 * Débranche le compte, chez nous puis chez Stripe.
 *
 * Rend la connexion supprimée, comme toutes les suppressions de cette API.
 */
export function disconnectStripe(projectId: string): Promise<Integration> {
  return write(
    `/v1/projects/${projectId}/integrations/stripe`,
    integrationSchema,
    undefined,
    'DELETE',
  );
}

/** Là où l'on retient le projet le temps de l'aller-retour chez Stripe. */
const PENDING_PROJECT_KEY = 'eh:stripe:pending-project';

/**
 * Retenir quel projet on branche, le temps de l'aller-retour.
 *
 * L'URL de retour est déclarée **une fois** chez Stripe et ne peut pas porter
 * l'identifiant du projet. Il faut donc s'en souvenir, et `sessionStorage` est
 * ce qui convient : l'onglet qui revient de Stripe est celui qui est parti, la
 * valeur meurt avec lui, et rien n'en subsiste si quelqu'un abandonne en route.
 *
 * Le jeton d'état, lui, contient déjà le projet — mais il est signé, et le lire
 * ici ferait dépendre le dashboard d'un format que le serveur doit rester libre
 * de changer.
 */
export function rememberPendingProject(projectId: string): void {
  sessionStorage.setItem(PENDING_PROJECT_KEY, projectId);
}

/** Le projet qu'on branchait, consommé — un retour ne vaut qu'une fois. */
export function takePendingProject(): string | null {
  const projectId = sessionStorage.getItem(PENDING_PROJECT_KEY);

  sessionStorage.removeItem(PENDING_PROJECT_KEY);

  return projectId;
}

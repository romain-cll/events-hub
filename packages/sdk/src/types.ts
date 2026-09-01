/**
 * Types partagés entre le client (`index.ts`) et les collecteurs.
 *
 * Ils vivent dans leur propre module pour une raison mécanique : `index.ts`
 * importe les collecteurs, les collecteurs ont besoin de ces types. Les mettre
 * dans `index.ts` créerait un cycle d'imports pour rien.
 */

/** Contexte navigateur collecté par le SDK. Clés pointées, namespacées. */
export type EventAttributes = Record<string, unknown>;

/** Charge décrivant l'événement lui-même. Clés pointées, namespacées. */
export type EventProperties = Record<string, unknown>;

export interface EmitOptions {
  /**
   * Passe par `navigator.sendBeacon` au lieu de `fetch`.
   *
   * Réservé aux événements émis pendant que le document part : un `fetch`
   * normal est annulé avec la page, un beacon est confié au navigateur qui le
   * livre après.
   */
  beacon?: boolean;
}

/**
 * Ce qu'un collecteur reçoit pour émettre.
 *
 * Volontairement synchrone et sans valeur de retour : un collecteur observe le
 * navigateur, il n'a rien à faire du sort de la requête. C'est le client qui
 * décide quoi faire d'un échec (voir `AnalyticsOptions.onError`) — laisser une
 * promesse remonter jusqu'ici obligerait chaque écouteur d'événement DOM à la
 * gérer, dans un contexte où personne ne peut rien en faire.
 */
export type Emit = (
  type: string,
  properties?: EventProperties,
  options?: EmitOptions,
) => void;

/** Débranche un collecteur : écouteurs retirés, monkey-patchs restaurés. */
export type Teardown = () => void;

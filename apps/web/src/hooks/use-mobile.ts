import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => {
    mql.removeEventListener('change', onChange);
  };
}

/**
 * Vrai sous 768px. Lu, pas synchronisé.
 *
 * ## Pourquoi `useSyncExternalStore` et pas un effet
 *
 * La version livrée par shadcn s'abonne dans un `useEffect` puis appelle
 * `setState` dans le corps de l'effet pour rattraper la valeur initiale. Ça
 * marche, mais ça rend deux fois — une passe à « pas mobile » suivie d'une
 * correction — et React signale le motif comme une cascade évitable.
 *
 * Ici la largeur de la fenêtre est ce qu'elle est : une source extérieure
 * qu'on *lit*, pas un état que React possède. `useSyncExternalStore` est
 * exactement fait pour ça, et supprime le double rendu.
 *
 * ## Le troisième argument n'est pas optionnel ici
 *
 * L'application rend côté serveur, où `window` n'existe pas. `getServerSnapshot`
 * répond « pas mobile », ce qui correspond au premier rendu client sur un
 * écran large et évite une différence d'hydratation. Sur mobile, le client
 * corrige au premier abonnement — un rendu, pas deux.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

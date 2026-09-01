import type { Teardown } from '../types.ts';

/** Le geste de navigation à l'origine du changement d'URL. */
export type NavigationType = 'push_state' | 'replace_state' | 'pop_state';

/**
 * Prévient à chaque changement d'URL piloté par l'application.
 *
 * `pushState` et `replaceState` ne déclenchent **aucun** événement natif : une
 * SPA change d'URL sans que rien ne l'annonce. Il n'existe pas d'autre moyen de
 * l'apprendre que d'envelopper les deux méthodes — d'où le monkey-patch, qui
 * est ici la solution correcte et pas un contournement.
 *
 * L'original est appelé **avant** de prévenir : les collecteurs doivent lire un
 * `window.location` déjà à jour. Et son retour est propagé tel quel pour que
 * l'enveloppement reste invisible au routeur qui l'appelle.
 *
 * Au débranchement, on ne restaure que si la méthode est toujours la nôtre :
 * un autre outil (routeur, autre SDK) a pu patcher par-dessus entre-temps, et
 * lui écraser son wrapper le casserait silencieusement.
 */
export function onLocationChange(
  listen: (type: NavigationType) => void,
): Teardown {
  // `unbound-method` met en garde contre un `this` perdu ; ici c'est
  // exactement ce qu'on veut. On garde les références nues pour pouvoir les
  // reposer telles quelles au débranchement, et on les rappelle avec le `this`
  // d'origine via `.call()` — les lier figerait un wrapper dans `history` pour
  // toujours.
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalPush = window.history.pushState;
  const originalReplace = window.history.replaceState;
  /* eslint-enable @typescript-eslint/unbound-method */

  const patchedPush = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalPush.call(this, data, unused, url);
    listen('push_state');
  };

  const patchedReplace = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalReplace.call(this, data, unused, url);
    listen('replace_state');
  };

  // `popstate`, lui, est natif : bouton retour, `history.back()`, `go()`.
  const onPopState = () => {
    listen('pop_state');
  };

  window.history.pushState = patchedPush;
  window.history.replaceState = patchedReplace;
  window.addEventListener('popstate', onPopState);

  return () => {
    if (window.history.pushState === patchedPush) {
      window.history.pushState = originalPush;
    }
    if (window.history.replaceState === patchedReplace) {
      window.history.replaceState = originalReplace;
    }
    window.removeEventListener('popstate', onPopState);
  };
}

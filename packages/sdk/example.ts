/**
 * Vérification manuelle du SDK contre l'API locale.
 *
 * `pnpm --filter @events-hub/sdk demo` (l'API doit tourner : `pnpm dev`).
 *
 * Hors navigateur, deux comportements se vérifient ici et nulle part ailleurs :
 * `attributes` revient vide (le garde `window`), et `start()` ne branche rien
 * plutôt que de lever. C'est le cas d'un rendu serveur.
 *
 * Le contexte navigateur, lui, se teste depuis la page de `example/`.
 */
import { Analytics } from './src/index.ts';

const analytics = new Analytics({
  apiKey: 'eh_pk_2e95b1b62a96443a919f2b3661106689',
  endpoint: 'http://localhost:3003/v1/events',
});

analytics.start(); // sans effet : pas de `window`.

console.log(await analytics.track('page_view', { source: 'node-demo' }));

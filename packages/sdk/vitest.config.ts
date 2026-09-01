import { defineConfig } from 'vitest/config';

/**
 * Les collecteurs n'existent que par le DOM : ils écoutent `document`, patchent
 * l'History API et lisent `window.location`. Les tester sans navigateur
 * reviendrait à tester des mocks. `jsdom` fournit les vraies primitives —
 * propagation des événements, `closest()`, historique de session.
 *
 * L'URL de départ est explicite parce que la moitié des comportements testés en
 * dépend : l'anti-doublon de `page_view` compare des chemins, et
 * `outbound_click` compare des origines. Sans origine connue, « lien sortant »
 * n'a pas de sens.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'https://site.test/' },
    },
  },
});

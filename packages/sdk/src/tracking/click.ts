import { describeElement, findInteractive } from '../browser/element.ts';
import type { Emit, Teardown } from '../types.ts';

/**
 * Émet un `click` pour tout clic sur un élément interactif.
 *
 * Un seul écouteur, sur `document`, en phase de bulle : c'est ce qui permet de
 * capturer les éléments ajoutés au DOM après le démarrage du SDK (une SPA en
 * ajoute en permanence) sans jamais re-scanner la page. Écouter en capture
 * attraperait les clics que le site annule ensuite — on veut au contraire voir
 * le clic tel que le site l'a laissé passer.
 *
 * Ce qui n'est pas interactif est ignoré, et rien du contenu n'est lu : voir
 * `describeElement`.
 */
export function trackClicks(emit: Emit): Teardown {
  const onClick = (event: MouseEvent) => {
    const element = findInteractive(event.target);
    if (!element) return;

    emit('click', describeElement(element));
  };

  document.addEventListener('click', onClick);

  return () => {
    document.removeEventListener('click', onClick);
  };
}

import { describeElement } from '../browser/element.ts';
import { isOutbound, resolveUrl } from '../browser/url.ts';
import type { Emit, Teardown } from '../types.ts';

/**
 * Émet un `outbound_click` quand un lien mène hors du site, et signale le
 * départ quand ce lien va effectivement emporter la page.
 *
 * Écouteur séparé de celui de `click` : les deux collecteurs restent
 * indépendants et testables isolément. Un clic sur un lien sortant produit donc
 * `click` **puis** `outbound_click`, dans cet ordre — les écouteurs d'un même
 * nœud sont appelés dans leur ordre d'enregistrement, et `index.ts` branche
 * `click` en premier. `outbound_click` n'est pas un `click` d'un autre genre,
 * c'est un fait supplémentaire sur le même clic.
 *
 * ## Ce qui déclenche un `page_leave`, et ce qui n'en déclenche pas
 *
 * Poster le départ *depuis le gestionnaire de clic* est ce qui permet de le
 * capturer : après, la page est déjà partie. Le beacon rend la main tout de
 * suite, la navigation n'est jamais retardée et rien n'est bloqué.
 *
 * Mais tous les clics sortants n'emportent pas la page : Cmd/Ctrl-clic,
 * `target="_blank"`, `download`, ou un `preventDefault()` du site ouvrent
 * ailleurs ou ne naviguent pas. Y émettre un `page_leave` serait faux deux
 * fois : on inventerait un départ, et le drapeau de déduplication avalerait le
 * vrai départ quand il finirait par arriver. Dans ces cas-là, le fait
 * `outbound_click` est bien rapporté — le clic a eu lieu — mais pas le départ.
 */
export function trackOutboundClicks(
  emit: Emit,
  onLeaving: () => void,
): Teardown {
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const anchor = target.closest('a');
    if (!anchor?.href) return;

    const destination = resolveUrl(anchor.href);
    if (!destination || !isOutbound(destination)) return;

    emit('outbound_click', {
      ...describeElement(anchor),
      // Dérivée de `element.href`, mais c'est elle qui sert : « vers quels
      // sites partent nos visiteurs » se lit par un GROUP BY, pas par un
      // parsing d'URL dans chaque requête.
      'link.origin': destination.origin,
    });

    if (!leavesThisPage(event, anchor)) return;

    onLeaving();
  };

  document.addEventListener('click', onClick);

  return () => {
    document.removeEventListener('click', onClick);
  };
}

/** Ce clic va-t-il emporter le document courant ? */
function leavesThisPage(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  // Le site a pris la main (routeur, lightbox, confirmation) : pas de
  // navigation. Notre écouteur bulle jusqu'à `document`, donc un
  // `preventDefault()` posé sur le lien lui-même a déjà eu lieu.
  if (event.defaultPrevented) return false;

  // Clic auxiliaire ou modifié : nouvel onglet, nouvelle fenêtre,
  // téléchargement. La page courante reste.
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  if (anchor.hasAttribute('download')) return false;

  return anchor.target === '' || anchor.target === '_self';
}

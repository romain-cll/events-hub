import type { EventProperties } from '../types.ts';

/**
 * Ce qu'on considère comme un élément interactif.
 *
 * La liste est volontairement fermée. Écouter *tous* les clics remonterait
 * surtout du bruit — un clic sur un `<div>` de mise en page n'est pas une
 * intention — et exposerait la structure entière du DOM de chaque site. Ces
 * sept sélecteurs couvrent ce qui est cliquable au sens de l'utilisateur.
 */
export const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"]';

/**
 * Remonte du nœud cliqué jusqu'à l'élément interactif qui le contient.
 *
 * `event.target` est le nœud le plus profond : sur `<button><span>OK</span></button>`
 * c'est le `<span>`. Sans ce `closest()`, la moitié des clics sur des boutons
 * réels — ceux qui contiennent une icône ou un libellé enveloppé — seraient
 * classés comme non interactifs.
 */
export function findInteractive(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;

  return target.closest(INTERACTIVE_SELECTOR);
}

/**
 * Décrit un élément sans jamais lire ni son texte ni sa valeur.
 *
 * C'est la règle de la V1 et elle n'a pas d'exception : `textContent` et
 * `value` ne sont pas lus, nulle part. Le texte d'un bouton peut contenir un
 * nom (« Supprimer le compte de Marie »), la valeur d'un champ contient par
 * définition ce que l'utilisateur a tapé. Tout ce qui est capturé ici est
 * écrit par l'auteur du site dans son propre HTML.
 *
 * `class` est écartée du lot : avec du CSS utilitaire elle fait des centaines
 * d'octets de style par clic et n'identifie rien de stable.
 *
 * `element.href` est la forme **résolue** (absolue) : c'est elle qui permet de
 * décider si un lien sort du site, et un `href` relatif seul ne le dit pas.
 */
export function describeElement(element: Element): EventProperties {
  return compact({
    'element.tag': element.tagName.toLowerCase(),
    'element.id': element.id,
    'element.name': element.getAttribute('name'),
    'element.type': element.getAttribute('type'),
    'element.role': element.getAttribute('role'),
    'element.href':
      element instanceof HTMLAnchorElement ? element.href : undefined,
  });
}

/**
 * Retire les clés sans information.
 *
 * `getAttribute` rend `null` pour un attribut absent et `element.id` rend `''`.
 * Envoyer ces clés vides obligerait chaque requête en aval à distinguer
 * « absent » de « vide » — même raisonnement que `page.referrer`.
 */
export function compact(
  descriptor: Record<string, string | null | undefined>,
): EventProperties {
  return Object.fromEntries(
    Object.entries(descriptor).filter(([, value]) => Boolean(value)),
  );
}

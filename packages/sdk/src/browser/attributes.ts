import type { EventAttributes } from '../types.ts';
import { SDK_VERSION } from '../version.ts';

/**
 * Lit le contexte navigateur disponible au moment de l'appel.
 *
 * Le garde `window` n'est pas de la prudence gratuite : un `track()` peut
 * partir d'un rendu serveur (TanStack Start, Next…) où ni `window` ni
 * `document` n'existent. Un événement sans contexte vaut mieux qu'un
 * `ReferenceError` qui casse la page hôte.
 *
 * `page.url` est envoyée entière, query et fragment compris. Décider ce qui est
 * sensible là-dedans est un travail serveur : le SDK tourne chez le client, ce
 * qu'il filtre n'est ni vérifiable ni modifiable après coup.
 *
 * Ces clés sont relues à *chaque* événement, jamais mises en cache : après une
 * navigation SPA, `page.path` doit décrire la page où le clic a eu lieu, pas
 * celle où le SDK a démarré.
 */
export function collectAttributes(): EventAttributes {
  if (typeof window === 'undefined') return {};

  const attributes: EventAttributes = {
    // Le seul attribut qui ne décrive pas le navigateur mais **l'émetteur**. Il
    // est là pour qu'une version du SDK qui envoie du mauvais soit identifiable
    // après coup, sans avoir à deviner qui tourne où.
    'sdk.version': SDK_VERSION,
    'page.path': window.location.pathname,
    'page.url': window.location.href,
    'browser.language': navigator.language,
    'screen.width': window.screen.width,
    'screen.height': window.screen.height,
  };

  // `document.referrer` vaut `''` sur une entrée directe. Une chaîne vide n'est
  // pas une information : on omet la clé plutôt que d'obliger chaque requête en
  // aval à distinguer « pas de referrer » de « referrer vide ».
  //
  // Il reste le referrer *du chargement du document* pour toute la durée de
  // vie de la page : après une navigation SPA il ne bouge pas. C'est
  // `navigation.from` sur `page_view` qui porte l'enchaînement interne.
  if (document.referrer) {
    attributes['page.referrer'] = document.referrer;
  }

  return attributes;
}

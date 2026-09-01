import { onLocationChange, type NavigationType } from '../browser/history.ts';
import { internalReferrer, pageKey } from '../browser/url.ts';
import type { Emit, EventProperties, Teardown } from '../types.ts';

/** Ce qui a amené sur la page. `initial` = le chargement du document. */
type PageViewTrigger = NavigationType | 'initial';

/**
 * Émet un `page_view` au chargement puis à chaque navigation SPA.
 *
 * Le SDK ne produit **qu'un** `page_view` : il n'existe pas d'événement
 * `navigation` à côté. Le geste (`push_state`, `pop_state`…) est une propriété
 * de la vue de page, pas un fait séparé — deux types d'événements pour un seul
 * fait obligeraient chaque requête en aval à les recoller.
 *
 * ## L'anti-doublon
 *
 * `lastTrackedUrl` garde la dernière URL comptée et la compare sur
 * `pathname + search` (voir `pageKey`). Sans lui, deux cas très courants
 * doublent le trafic sans que ça se voie :
 *
 * - un routeur qui appelle `replaceState` avec l'URL courante juste après le
 *   chargement (normalisation d'URL, hydratation) — d'où le test qui vérifie
 *   que « chargement initial + `replaceState` identique » fait bien 1 ;
 * - un `pushState` qui ne change que le state, pas l'URL.
 *
 * La comparaison est donc sur l'URL, pas sur le geste : c'est la page vue qui
 * compte, pas le nombre d'appels à l'History API.
 *
 * ## `navigation.from` veut dire la même chose partout
 *
 * La page précédente du même site, quelle que soit la façon dont on y est
 * arrivé : `pushState` en SPA, rechargement de document en MPA. Deux sources
 * différentes — la dernière page comptée d'un côté, `document.referrer` de
 * l'autre — mais une seule clé et une seule forme en sortie.
 *
 * Sans cette normalisation, un consommateur devrait écrire
 * `coalesce(navigation.from, page.referrer)` et savoir *à quel type de site* il
 * a affaire pour interpréter le résultat. Ce bricolage-là n'appartient à
 * personne en aval : c'est ici qu'on sait comment la page a été atteinte.
 *
 * Une entrée externe (moteur de recherche, autre site) ou directe n'a pas de
 * page précédente : la clé est absente, et la source reste dans `page.referrer`.
 */
export function trackPageViews(emit: Emit): Teardown {
  let lastTrackedUrl: string | null = null;

  const send = (trigger: PageViewTrigger) => {
    const url = pageKey();
    if (url === lastTrackedUrl) return;

    const properties: EventProperties = { 'navigation.type': trigger };

    // La page comptée juste avant si on en a une — c'est le cas dès la deuxième
    // vue, et c'est toujours plus sûr que le referrer, qui reste figé au
    // chargement du document et ne bouge plus d'une navigation SPA à l'autre.
    // Sinon seulement, le referrer, qui est la seule trace disponible sur la
    // toute première vue d'un document.
    const from = lastTrackedUrl ?? internalReferrer();

    // `from === url` arrive sur un rechargement, ou sur une navigation qui ne
    // change que le fragment (`/pricing` -> `/pricing#faq`) : le hash ne fait
    // pas partie de l'identité d'une page ici, donc les deux vues portent la
    // même clé. Se déclarer sa propre page précédente ne décrit aucun parcours.
    if (from !== null && from !== url) {
      properties['navigation.from'] = from;
    }

    lastTrackedUrl = url;
    emit('page_view', properties);
  };

  send('initial');

  return onLocationChange(send);
}

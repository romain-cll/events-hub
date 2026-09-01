import { eventsPageSchema, type EventsPage } from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson } from './api';
import { windowFor, type Period, type Window } from './analytics';

export type { EventsPage };

/**
 * `GET /v1/projects/:projectId/events` — le journal brut, page par page.
 *
 * ## Ce qui la distingue des lectures analytiques
 *
 * `summaryQuery` et `sessionsQuery` répondent à la fenêtre entière : une seule
 * requête, un seul résultat, et tout le découpage se refait ensuite dans
 * `analytics-rollup.ts`. Ici la fenêtre ne tient pas dans une réponse — le
 * journal d'un projet vivant se compte en dizaines de milliers de lignes — donc
 * la lecture est paginée, et la position fait partie de la clé de cache.
 *
 * ## La fenêtre se calcule au même endroit que pour les analytics
 *
 * `windowFor` est importée plutôt que recopiée. C'est ce qui garantit que « les
 * 7 derniers jours » désigne exactement la même chose sur les deux écrans —
 * sept journées UTC pleines, alignées, stables dans la journée. Une seconde
 * implémentation dériverait, et la dérive ne se verrait qu'en comparant deux
 * écrans côte à côte.
 */

/** Ce qu'un écran demande : une fenêtre, un filtre, une position. */
export interface EventsRequest {
  /**
   * Trois états, et les trois disent autre chose.
   *
   * `undefined` : aucun filtre, donc tous les types. C'est ce que l'API
   * comprend quand le paramètre manque, et c'est l'état par défaut de l'écran.
   *
   * Une liste : ceux-là.
   *
   * Une liste **vide** : aucun. Ce n'est pas « tous », et ça ne part jamais sur
   * le réseau — dans une query string, une liste vide s'écrit comme une absence,
   * donc l'API rendrait tout le journal là où le lecteur n'attend rien.
   */
  types: string[] | undefined;
  /** Le curseur rendu par la page précédente. Absent : le début de la fenêtre. */
  after?: string;
}

function search(window: Window, { types, after }: EventsRequest): string {
  const params = new URLSearchParams({ from: window.from });

  if (window.to) params.set('to', window.to);

  // L'absence de filtre s'écrit par l'absence du paramètre. La liste vide, elle,
  // n'atteint jamais cette fonction — voir `enabled`.
  if (types !== undefined && types.length > 0)
    params.set('types', types.join(','));

  if (after !== undefined) params.set('after', after);

  return `?${params.toString()}`;
}

/**
 * Une page du journal.
 *
 * ## La requête ne part pas quand aucun type n'est coché
 *
 * `enabled` le décide ici plutôt que dans l'écran : c'est une propriété de la
 * lecture, pas de l'affichage. Sans lui, décocher le dernier type enverrait une
 * requête sans filtre — donc tout le journal — exactement quand le lecteur a
 * demandé le contraire.
 *
 * ## Le curseur est dans la clé, et il le faut
 *
 * Deux pages de la même fenêtre sont deux lectures différentes. L'omettre les
 * ferait partager une entrée de cache, et la page suivante afficherait la
 * précédente jusqu'au retour du réseau.
 */
export function eventsQuery(
  projectId: string,
  days: Period,
  offset: number,
  request: EventsRequest,
) {
  const window = windowFor(days, offset);

  return queryOptions({
    queryKey: ['events', projectId, window, request],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/events${search(window, request)}`,
        eventsPageSchema,
      ),
    enabled: request.types === undefined || request.types.length > 0,
    // La page précédente reste affichée pendant que la suivante arrive : sans
    // ça, chaque coup de chevron viderait le tableau puis le remplirait, et la
    // page sauterait de toute sa hauteur à chaque pas.
    placeholderData: (previous) => previous,
  });
}

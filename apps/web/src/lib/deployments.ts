import { eventsPageSchema } from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson } from './api';
import {
  startOfUtcDay,
  windowFor,
  type Period,
  type Window,
} from './analytics';

/**
 * Le type d'événement qu'un déploiement porte, et la clé qui le nomme.
 *
 * Écrits ici et pas ailleurs. Le hub, lui, n'en connaît aucun — c'est la
 * promesse du produit, et `architecture.spec.ts` la tient côté API. Ce fichier
 * est l'endroit *du dashboard* qui a le droit de savoir ce qu'un déploiement
 * est, exactement comme un module de `features/` côté serveur.
 *
 * `deploy.env` n'existe pas : un projet est un environnement, donc la clé
 * vaudrait la même chose sur toutes les lignes d'un projet. `deploy.status` non
 * plus : un déploiement échoué qui n'a rien changé n'explique aucun pic.
 */
const DEPLOYMENT_TYPE = 'deployment';
const RELEASE_TAG = 'release.tag';

/**
 * Combien de pages on suit avant d'arrêter.
 *
 * Le journal rend vingt lignes par page, donc quatre cents déploiements sur la
 * fenêtre regardée. Au-delà, ce n'est plus un repère : quatre cents points sur
 * trente jours ne se lisent pas, et le graphique aurait cessé d'aider bien
 * avant. La borne existe pour qu'une boucle sur un curseur ne puisse pas
 * tourner sans fin, pas pour rationner une donnée que quelqu'un attendrait.
 */
const MAX_PAGES = 20;

/** Les déploiements d'une journée UTC, prêts à poser sur un axe. */
export interface DayDeployments {
  /** Début de la journée UTC — même forme que `ComparedDay.start`. */
  start: string;
  /**
   * Les versions déployées ce jour-là, de la plus ancienne à la plus récente.
   *
   * Une entrée par déploiement, y compris sans `release.tag` — un déploiement
   * qui ne dit pas ce qu'il a déployé reste un déploiement, et le compter
   * seulement quand il est étiqueté ferait mentir le nombre.
   */
  tags: (string | null)[];
}

/**
 * Les déploiements de la fenêtre, repliés par journée.
 *
 * ## Pas de route dédiée, et c'est la règle qu'on s'est donnée
 *
 * Un déploiement est un événement ordinaire. Il se lit donc par le **journal
 * brut** filtré sur son type, comme n'importe quel type métier qu'un client
 * inventerait. Une route `/deployments` aurait demandé une seconde le jour des
 * erreurs, puis une troisième — alors que le découpage qui tient est
 * brut/calculé, pas un point d'entrée par famille.
 *
 * ## Pourquoi on suit le curseur
 *
 * Cette lecture veut *toute* la fenêtre, là où l'explorateur veut une page. Une
 * seule page afficherait vingt marqueurs sans dire que d'autres existent, et
 * c'est exactement le genre de troncature silencieuse qui se lit comme une
 * couverture complète. Le nombre de déploiements est petit par nature, donc la
 * boucle est courte.
 */
async function readAll(
  projectId: string,
  window: Window,
): Promise<DayDeployments[]> {
  const byDay = new Map<string, (string | null)[]>();
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      from: window.from,
      types: DEPLOYMENT_TYPE,
    });

    if (window.to) params.set('to', window.to);
    if (after !== undefined) params.set('after', after);

    const result = await apiJson(
      `/v1/projects/${projectId}/events?${params.toString()}`,
      eventsPageSchema,
    );

    for (const event of result.events) {
      const start = startOfUtcDay(event.occurredAt).toISOString();
      const tag = event.properties[RELEASE_TAG];

      byDay.set(start, [
        // Le journal descend vers le passé : on empile en tête pour que chaque
        // journée se lise du plus ancien au plus récent, comme on la raconte.
        typeof tag === 'string' ? tag : null,
        ...(byDay.get(start) ?? []),
      ]);
    }

    if (result.nextCursor === null) break;

    after = result.nextCursor;
  }

  return [...byDay].map(([start, tags]) => ({ start, tags }));
}

/**
 * Les déploiements de la même fenêtre que les courbes.
 *
 * `windowFor` est partagée avec `summaryQuery` : les points tombent donc
 * exactement sur les journées que l'axe porte, sans qu'un décalage d'un jour
 * puisse s'installer entre les deux lectures.
 */
export function deploymentsQuery(
  projectId: string,
  days: Period,
  offset: number,
) {
  const window = windowFor(days, offset);

  return queryOptions({
    queryKey: ['deployments', projectId, window],
    queryFn: () => readAll(projectId, window),
  });
}

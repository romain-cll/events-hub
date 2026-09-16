import {
  revenueAttributionPageSchema,
  type RevenueAttributionPage,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { windowFor, type Period } from './analytics';
import { apiJson } from './api';

export type { RevenueAttributionPage };

/**
 * L'accès aux lectures de revenu, et il n'y en a qu'une pour l'instant.
 *
 * ## Une route pour toute la page
 *
 * `/revenue/attribution` range les mêmes paiements sur les axes qu'on lui
 * demande — campagne, provenance, page d'entrée, pays, navigateur, système,
 * appareil. Deux cartes de la page s'en servent, et un seul appel les sert
 * toutes les deux : des appels séparés laisseraient leurs totaux diverger dès
 * qu'un paiement arrive entre les deux.
 *
 * ## Les axes sont dans la clé de cache, et ils doivent y être
 *
 * La réponse ne porte **que** les axes demandés. Sans eux dans la clé, une vue
 * qui en demande deux servirait sa réponse tronquée à celle qui en demande sept,
 * et les colonnes de revenu disparaîtraient sans rien qui le signale.
 *
 * L'onglet actif, lui, n'y est **pas** : basculer de Campaigns à Sources ne
 * change pas ce qui a été chargé, seulement ce qui est affiché. C'est tout
 * l'intérêt de demander les axes d'une carte en une fois.
 */

/** Les axes que la page sait afficher, dans l'ordre où l'API les nomme. */
export type AttributionAxis =
  | 'campaign'
  | 'source'
  | 'landing'
  | 'country'
  | 'browser'
  | 'os'
  | 'device';

/** Ce que la carte Acquisition montre. */
export const ACQUISITION_AXES = [
  'campaign',
  'source',
  'landing',
  'country',
] as const satisfies readonly AttributionAxis[];

/** Ce que la carte « Who they are » montre, en plus du pays qu'elle partage. */
export const AUDIENCE_AXES = [
  'country',
  'browser',
  'os',
  'device',
] as const satisfies readonly AttributionAxis[];

/** L'union des deux : un seul appel sert la page entière. */
export const PAGE_AXES = [
  ...new Set([...ACQUISITION_AXES, ...AUDIENCE_AXES]),
] as AttributionAxis[];

export function attributionQuery(
  projectId: string,
  days: Period,
  offset = 0,
  axes: readonly AttributionAxis[] = PAGE_AXES,
  limit = 10,
) {
  const window = windowFor(days, offset);
  const params = new URLSearchParams({
    from: window.from,
    axes: axes.join(','),
    limit: String(limit),
  });

  if (window.to) params.set('to', window.to);

  return queryOptions({
    queryKey: [
      'revenue',
      projectId,
      'attribution',
      window,
      [...axes].sort(),
      limit,
    ],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/revenue/attribution?${params.toString()}`,
        revenueAttributionPageSchema,
      ),
  });
}

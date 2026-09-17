import {
  revenueAttributionPageSchema,
  revenueSeriesPageSchema,
  type RevenueAttributionPage,
  type RevenueSeriesPage,
  type SeriesStep,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { windowFor, type Period } from './analytics';
import { apiJson } from './api';

export type { RevenueAttributionPage, RevenueSeriesPage, SeriesStep };

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
  | 'referrer'
  | 'landing'
  | 'country'
  | 'browser'
  | 'os'
  | 'device';

/**
 * Ce que la carte Acquisition montre.
 *
 * `source` et `referrer` sont deux grains du même classement, pas deux
 * calculs : le premier répond « quelle **famille** de trafic me rapporte », le
 * second « quel **site** ». Le pays n'y est plus — il a sa carte, avec son
 * planisphère, et le laisser ici le faisait compter deux fois.
 */
export const ACQUISITION_AXES = [
  'source',
  'campaign',
  'referrer',
  'landing',
] as const satisfies readonly AttributionAxis[];

/**
 * Ce que la carte « Who they are » montre.
 *
 * Le pays en faisait partie, sans qu'aucun onglet ne l'affiche : il avait déjà
 * déménagé dans Locations, l'axe était resté. Une agrégation SQL par axe, donc
 * une passe payée à chaque ouverture pour une colonne que personne ne voyait.
 */
export const AUDIENCE_AXES = [
  'browser',
  'os',
  'device',
] as const satisfies readonly AttributionAxis[];

/**
 * Ce que la carte Locations joint à son classement de visiteurs.
 *
 * Elle le demande elle-même plutôt que de le recevoir de la page : sa lecture
 * ne porte qu'un axe mais le veut **profond**, là où les deux tableaux d'en
 * face en veulent sept et n'en montrent que dix lignes. Un seul appel pour les
 * deux besoins servirait mal celui qu'il ne dimensionne pas.
 */
export const LOCATION_AXES = [
  'country',
] as const satisfies readonly AttributionAxis[];

/**
 * Le plafond que la route accepte sur `limit`, et qu'il faut connaître ici :
 * au-delà elle rend 400, pas un classement tronqué.
 */
export const MAX_ATTRIBUTION_LIMIT = 100;

/** L'union des deux tableaux : un seul appel les sert tous les deux. */
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

/**
 * Le revenu dans le temps, au pas demandé.
 *
 * ## Pourquoi cette série ne se replie pas côté client
 *
 * Le trafic, si — la page tient déjà la liste des sessions, et les regrouper par
 * jour ne coûte qu'un parcours. Une **somme d'argent**, non : la redescendre
 * entière ferait additionner tous les paiements de la fenêtre dans un
 * navigateur, et deux pages qui referaient ce calcul finiraient par diverger.
 *
 * Le total de cette série égale celui d'`attributionQuery` sur la même fenêtre,
 * devise par devise — les deux lectures visent les mêmes types côté serveur.
 * C'est ce qui permet d'afficher le graphique et le tableau côte à côte sans
 * qu'ils se contredisent.
 *
 * Le pas est dans la clé de cache : deux pas différents ne rendent pas la même
 * liste, et l'omettre servirait une courbe mensuelle à qui demande des jours.
 */
export function revenueSeriesQuery(
  projectId: string,
  days: Period,
  offset = 0,
  step: SeriesStep = 'day',
) {
  const window = windowFor(days, offset);
  const params = new URLSearchParams({ from: window.from, step });

  if (window.to) params.set('to', window.to);

  return queryOptions({
    queryKey: ['revenue', projectId, 'series', window, step],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/revenue/series?${params.toString()}`,
        revenueSeriesPageSchema,
      ),
  });
}

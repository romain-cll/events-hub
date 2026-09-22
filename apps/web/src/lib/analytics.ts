import {
  analyticsSummarySchema,
  locationsPageSchema,
  sessionsPageSchema,
  technologyPageSchema,
  type AnalyticsSummary,
  type LocationGrain,
  type LocationsPage,
  type SessionsPage,
  type TechnologyGrain,
  type TechnologyPage,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson } from './api';

export type {
  AnalyticsSummary,
  LocationGrain,
  LocationsPage,
  SessionsPage,
  TechnologyGrain,
  TechnologyPage,
};

/**
 * Accès aux **deux** routes analytiques, et il n'y en a que deux.
 *
 * ## Ce que ce fichier remplace
 *
 * Il en appelait trois, et les trois étaient fausses : `?interval=day` sur un
 * schéma de requête strict (400), `/analytics/sources` supprimée (404), et six
 * agrégats attendus de `/analytics/sessions` là où la route rend **une liste de
 * sessions**. La page compilait et affichait `undefined` : les formes étaient
 * décrites ici, à la main, sans que rien ne les compare à l'API.
 *
 * Les schémas viennent maintenant de `@events-hub/api-contract`, contre lequel
 * l'API type ses retours (`apps/api/src/contract.spec.ts`). Une divergence
 * casse les deux côtés à la compilation, plus à l'écran.
 *
 * ## Le découpage temporel n'est plus demandé au serveur
 *
 * C'est le fond du changement, pas un détail d'implémentation. L'API a
 * délibérément rendu le pas, le fuseau et le calendrier au lecteur : elle sert
 * des agrégats de période d'un côté, des sessions **datées** de l'autre. Le
 * trafic quotidien, la ventilation par provenance et les totaux de session se
 * reconstruisent donc ici, dans `analytics-rollup.ts`.
 *
 * Les **visiteurs uniques par jour** ont manqué un temps : un compte de valeurs
 * distinctes n'est pas une somme, et la clé visiteur ne sort pas du serveur.
 * Chaque ligne de session porte maintenant un **alias** — opaque, retiré à
 * chaque appel, valable dans la réponse seule — et `dailyVisitors` s'en sert
 * pour dédoublonner journée par journée.
 */

/** Les fenêtres proposées, en jours pleins. */
export const PERIODS = [7, 30] as const;

export type Period = (typeof PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Le début de la journée UTC qui contient cet instant. */
export function startOfUtcDay(at: Date | string | number): Date {
  const date = new Date(at);

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Une fenêtre à envoyer à l'API. `to` absent : le serveur le résout. */
export interface Window {
  from: string;
  to?: string;
}

/**
 * La fenêtre d'une période, reculée de `offset` périodes.
 *
 * `offset` vaut zéro pour la période en cours, un pour celle d'avant, et ainsi
 * de suite. Les périodes sont **adjacentes et de même longueur** : celle
 * d'`offset` 1 s'arrête exactement là où celle d'`offset` 0 commence.
 *
 * ## Alignée sur la journée UTC, et c'est structurel
 *
 * « Les 7 derniers jours » vaut ici **7 journées UTC pleines**, pas 168 heures
 * glissantes. Deux raisons qui tiennent ensemble :
 *
 * - le graphique regroupe par journée UTC ; une borne à 14 h 32 donnerait un
 *   premier jour tronqué, plus bas que les autres, qu'on lirait comme une chute
 *   de trafic ;
 * - la valeur devient **stable dans la journée**, donc la clé de requête aussi.
 *   Une borne recalculée à chaque rendu en changerait à chaque rendu, et
 *   TanStack Query refetcherait en boucle — une panne discrète, visible
 *   seulement dans l'onglet réseau.
 *
 * ## `to` n'est envoyé que sur une période passée
 *
 * Sur la période en cours, l'API le résout à « maintenant » et **renvoie la
 * fenêtre retenue**. Le poser ici en ferait une seconde vérité à tenir
 * synchronisée entre les requêtes, et surtout une valeur qui bouge à chaque
 * rendu — donc une clé de requête qui bouge, donc la boucle de refetch décrite
 * plus haut.
 *
 * Sur une période passée, la borne haute **est** l'information : sans elle, le
 * serveur rendrait tout jusqu'à aujourd'hui. Elle est alors fixe, donc sans
 * danger pour la clé.
 */
export function windowFor(days: Period, offset = 0): Window {
  const first =
    startOfUtcDay(new Date()).getTime() - (days - 1 + offset * days) * DAY_MS;

  const window: Window = { from: new Date(first).toISOString() };

  if (offset > 0) window.to = new Date(first + days * DAY_MS).toISOString();

  return window;
}

/**
 * Les deux journées UTC qui bornent une période, pour l'affichage.
 *
 * Calculées ici plutôt que lues dans la réponse : le sélecteur doit pouvoir
 * écrire la période **avant** que la requête revienne, sinon il clignoterait à
 * chaque coup de chevron. La fenêtre étant déterministe côté client, il n'y a
 * rien à attendre.
 *
 * `last` est le début de la **dernière journée** de la période, pas la borne
 * haute exclue — c'est la date qu'on écrit à l'écran.
 */
export function periodBounds(
  days: Period,
  offset = 0,
): { first: Date; last: Date } {
  const first = new Date(windowFor(days, offset).from);

  return {
    first,
    last: new Date(first.getTime() + (days - 1) * DAY_MS),
  };
}

function search(window: Window): string {
  const params = new URLSearchParams({ from: window.from });

  if (window.to) params.set('to', window.to);

  return `?${params.toString()}`;
}

/**
 * `GET /v1/projects/:projectId/analytics` — les agrégats de la période.
 *
 * Bon marché quel que soit le volume : tout est calculé par Postgres, aucune
 * ligne ne remonte. Et il porte le seul chiffre que le lecteur ne peut pas
 * refaire — `uniqueVisitors`, dédupliqué sur une clé que le Core ne laisse pas
 * sortir.
 */
export function summaryQuery(projectId: string, days: Period, offset = 0) {
  const window = windowFor(days, offset);

  return queryOptions({
    queryKey: ['analytics', projectId, 'summary', window],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/analytics${search(window)}`,
        analyticsSummarySchema,
      ),
  });
}

/**
 * Le même résumé, sur la période **qui précède celle affichée**.
 *
 * C'est `summaryQuery` d'un cran en arrière, comme `previousSessionsQuery` est
 * `sessionsQuery` d'un cran en arrière : reculer d'une période, c'est
 * `offset + 1`, et cette arithmétique ne vit qu'à un seul endroit
 * (`windowFor`).
 *
 * Sert aux cartes du haut, qui affichent chacune leur évolution. Deux résumés
 * plutôt qu'une fenêtre deux fois plus large, pour la raison qui vaut déjà pour
 * les sessions : la fenêtre large répondrait sur soixante jours au lieu de
 * trente sans que rien à l'écran ne le dise.
 *
 * La clé de cache est celle de la fenêtre, donc reculer d'une période avec le
 * chevron réutilise le résumé déjà lu — celui d'`offset + 1` devient celui
 * d'`offset`.
 */
export function previousSummaryQuery(
  projectId: string,
  days: Period,
  offset = 0,
) {
  return summaryQuery(projectId, days, offset + 1);
}

/**
 * `GET /v1/projects/:projectId/analytics/sessions` — le journal replié.
 *
 * La donnée source de tout le reste de la page. Elle coûte plus cher que le
 * résumé — elle rend des lignes — d'où deux requêtes séparées plutôt qu'une :
 * les cartes d'agrégats s'affichent sans attendre le journal, et une panne de
 * l'une n'efface pas les autres.
 *
 * Le résumé sert de jauge : son `sessions` vaut exactement la longueur de cette
 * liste sur la même fenêtre.
 */
export function sessionsQuery(projectId: string, days: Period, offset = 0) {
  const window = windowFor(days, offset);

  // La fenêtre suffit à identifier la lecture, et `days`/`offset` n'y ajoutent
  // rien : les y mettre ferait deux clés pour un même appel. C'est le cas exact
  // de la période précédente — `previousSessionsQuery(7, 0)` et
  // `sessionsQuery(7, 1)` demandent la même chose, et se partagent le cache.
  return queryOptions({
    queryKey: ['analytics', projectId, 'sessions', window],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/analytics/sessions${search(window)}`,
        sessionsPageSchema,
      ),
  });
}

/**
 * La même lecture, sur la période **qui précède celle affichée**.
 *
 * C'est `sessionsQuery` d'un cran en arrière, et rien d'autre : reculer d'une
 * période est exactement ce que fait `offset + 1`. Il n'y a donc pas de second
 * calcul de fenêtre à tenir synchronisé avec le premier — le décalage est la
 * seule notion, et elle vit dans `windowFor`.
 *
 * ## Pourquoi une seconde requête plutôt qu'une fenêtre deux fois plus large
 *
 * Parce que la fenêtre large contaminerait tout le reste de la page :
 * `sessionTotals` et `trafficSources` répondraient sur soixante jours au lieu
 * de trente, sans que rien à l'écran ne le dise. La période précédente ne sert
 * qu'au graphique ; elle reste dans sa propre requête.
 *
 * ## Les alias des deux réponses ne se parlent pas
 *
 * Ils sont tirés au hasard à chaque appel, donc le même visiteur porte deux
 * jetons différents dans les deux réponses. C'est sans conséquence ici et il
 * faut le dire, parce que c'est le genre de détail qui se retourne : on ne
 * dédoublonne **jamais** entre les deux périodes, seulement à l'intérieur d'une
 * journée — et une journée tient entière dans une seule réponse.
 *
 * Le corollaire est une chose qu'on ne pourra pas faire sans changer de
 * montage : dire combien de visiteurs des deux périodes sont les mêmes. Ils ne
 * sont d'ailleurs pas comparables — la clé tourne chaque nuit.
 */
export function previousSessionsQuery(
  projectId: string,
  days: Period,
  offset = 0,
) {
  return sessionsQuery(projectId, days, offset + 1);
}

/**
 * `GET /v1/projects/:projectId/analytics/locations` — d'où viennent les
 * visiteurs.
 *
 * ## Une seule route pour les trois onglets
 *
 * Le grain est un paramètre, pas un chemin : la carte tape la même route selon
 * l'onglet ouvert. Le grain fait partie de la clé de cache, donc changer
 * d'onglet ne réinterroge que ce qui n'a pas déjà été lu, et revenir en arrière
 * est instantané.
 *
 * C'est aussi ce qui fera tenir le planisphère sans requête de plus : il
 * demandera toujours `country`, et quand l'onglet actif *est* Country les deux
 * lectures ont la même clé — TanStack Query n'en fait qu'une.
 *
 * ## `limit` est dans la clé, et il doit y être
 *
 * Deux lectures de la même fenêtre à deux bornes différentes ne rendent pas la
 * même liste. L'omettre ferait servir un top 10 à qui demande les 250 pays, une
 * fois sur deux et sans rien qui le signale.
 */
export function locationsQuery(
  projectId: string,
  days: Period,
  offset = 0,
  grain: LocationGrain = 'country',
  limit = 10,
) {
  const window = windowFor(days, offset);
  const params = new URLSearchParams({ from: window.from, grain });

  if (window.to) params.set('to', window.to);
  params.set('limit', String(limit));

  return queryOptions({
    queryKey: ['analytics', projectId, 'locations', window, grain, limit],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/analytics/locations?${params.toString()}`,
        locationsPageSchema,
      ),
  });
}

/**
 * Le classement par technologie — navigateur, système, type d'appareil.
 *
 * Jumelle de `locationsQuery`, jusqu'à la structure de sa clé de cache : même
 * route à un mot près, même double fermeture du grain au bord HTTP, et le même
 * `limit` dans la clé pour la même raison — deux bornes différentes ne rendent
 * pas la même liste.
 *
 * La route existait depuis le lot des User-Agents et n'était consommée par
 * personne : la carte qui l'affiche arrive avec cette page.
 */
export function technologyQuery(
  projectId: string,
  days: Period,
  offset = 0,
  grain: TechnologyGrain = 'browser',
  limit = 10,
) {
  const window = windowFor(days, offset);
  const params = new URLSearchParams({ from: window.from, grain });

  if (window.to) params.set('to', window.to);
  params.set('limit', String(limit));

  return queryOptions({
    queryKey: ['analytics', projectId, 'technology', window, grain, limit],
    queryFn: () =>
      apiJson(
        `/v1/projects/${projectId}/analytics/technology?${params.toString()}`,
        technologyPageSchema,
      ),
  });
}

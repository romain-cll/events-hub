import { z } from 'zod';

/** Fenêtre appliquée quand l'appelant n'en demande pas : les 7 derniers jours. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/**
 * `to` est résolu d'abord : un `?from=` seul doit donner « depuis cette date
 * jusqu'à maintenant », pas une fenêtre glissante autour d'autre chose.
 */
function resolve({ from, to }: { from?: Date; to?: Date }): {
  from: Date;
  to: Date;
} {
  const upper = to ?? new Date();

  return {
    from: from ?? new Date(upper.getTime() - DEFAULT_WINDOW_MS),
    to: upper,
  };
}

/**
 * Une fenêtre, et rien d'autre — le seul contrat d'entrée des deux lectures.
 *
 * ## Il n'y a plus de granularité
 *
 * `?interval=day` existait et déclenchait une série quotidienne. Le paramètre a
 * disparu à l'étape 33, avec la réponse qu'il produisait, parce qu'il faisait
 * décider au serveur du calendrier, du fuseau et du pas de l'axe — trois
 * décisions d'affichage. Le découpage appartient désormais au lecteur, qui reçoit
 * des sessions datées et les regroupe comme il l'entend : par heure, par jour,
 * par semaine.
 *
 * La série des visiteurs uniques par jour est tombée avec, et elle est revenue
 * du côté du lecteur : chaque ligne de `GET /analytics/sessions` porte un alias
 * de visiteur, opaque et valable dans la réponse seule, avec lequel il compte
 * ses distincts au pas qu'il choisit. Ce qui n'est pas revenu, et ne reviendra
 * pas par ce schéma, c'est un paramètre qui ferait choisir ce pas au serveur.
 *
 * ## Le strict n'est pas décoratif
 *
 * `strictObject` : un `?interval=day` resté dans un signet déclenche un 400 au
 * lieu d'être ignoré. Accepter un paramètre qu'on n'applique plus laisserait
 * croire à un cadrage qui n'a pas eu lieu — sur une API de lecture, c'est un
 * chiffre faux que rien ne signale.
 *
 * Les bornes sont validées comme ISO 8601 puis converties en `Date`, comme à
 * l'ingestion : la colonne `timestamptz` compare des instants absolus, pas des
 * chaînes. Elles sont toutes deux facultatives — un simple `GET` sans query doit
 * répondre quelque chose d'utile — et la fenêtre retenue est renvoyée dans la
 * réponse, donc le défaut n'est jamais implicite pour l'appelant.
 */
export const analyticsWindowSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
  })
  .transform(resolve)
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Fenêtre validée et résolue, telle que le service la reçoit. */
export type AnalyticsWindowDto = z.output<typeof analyticsWindowSchema>;

/**
 * Le grain d'un classement géographique.
 *
 * Trois valeurs, et elles nomment les trois onglets de la carte Locations. Un
 * `enum` plutôt qu'une chaîne libre : la valeur sert ensuite à choisir une
 * colonne dans `SESSION_COLUMNS`, et c'est cette double fermeture — au bord
 * HTTP puis dans le Core — qui garantit qu'aucune chaîne d'appelant n'atteint
 * le SQL.
 */
export const LOCATION_GRAINS = ['country', 'region', 'city'] as const;

/**
 * Les trois grains de technologie, et la même double fermeture.
 *
 * `device` côté requête, `deviceType` côté colonne : le premier est du
 * vocabulaire de produit, le second de schéma, et `TECHNOLOGY_COLUMNS` traduit.
 * Les confondre ferait entrer un nom de colonne dans une URL publique.
 */
export const TECHNOLOGY_GRAINS = ['browser', 'os', 'device'] as const;

/**
 * Le plafond du nombre de lignes rendues.
 *
 * Deux cent cinquante, parce que c'est assez pour **tous** les pays du monde —
 * le planisphère les demandera tous — et pas assez pour vider une table de
 * villes. Une réponse de lecture doit avoir une taille maximale connue, sinon
 * elle en a une qui dépend du trafic du client.
 */
const MAX_LIMIT = 250;

/**
 * `GET /v1/projects/:projectId/analytics/locations` — la fenêtre, plus deux
 * filtres.
 *
 * ## Un seul endpoint, et c'est le grain qui bouge
 *
 * La carte a trois onglets, et il n'y a pas trois routes : `grain` choisit la
 * colonne sur laquelle le classement porte. Le planisphère, lui, appellera la
 * même route figée sur `country` — quand l'onglet actif *est* Country, les deux
 * requêtes sont identiques et le cache du dashboard n'en fait qu'une.
 *
 * ## `strictObject`, comme la fenêtre seule
 *
 * Un paramètre inconnu rend 400 au lieu d'être ignoré. Sur une API de lecture,
 * un filtre silencieusement écarté ne produit pas une erreur visible : il
 * produit un chiffre juste à une question que personne n'a posée.
 *
 * `limit` arrive en chaîne — tout paramètre d'URL en est une — d'où la
 * coercition, bornée des deux côtés. `NaN` échoue sur `int()`, donc
 * `?limit=beaucoup` rend 400 plutôt que le défaut.
 */
export const analyticsLocationsSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    grain: z.enum(LOCATION_GRAINS).default('country'),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(10),
  })
  .transform(({ grain, limit, ...window }) => ({
    ...resolve(window),
    grain,
    limit,
  }))
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête de classement géographique, validée et résolue. */
export type AnalyticsLocationsDto = z.output<typeof analyticsLocationsSchema>;

/**
 * Le classement par technologie, même forme et même plafond.
 *
 * Le défaut est `browser` parce que c'est la question qu'on pose en premier
 * d'un navigateur. Le plafond de `limit` est celui des autres classements : il
 * n'existe pas deux cent cinquante navigateurs, mais un plafond partagé se
 * change à un seul endroit.
 */
export const analyticsTechnologySchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    grain: z.enum(TECHNOLOGY_GRAINS).default('browser'),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(10),
  })
  .transform(({ grain, limit, ...window }) => ({
    ...resolve(window),
    grain,
    limit,
  }))
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête de classement par technologie, validée et résolue. */
export type AnalyticsTechnologyDto = z.output<typeof analyticsTechnologySchema>;

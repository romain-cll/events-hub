import { z } from 'zod';

import { SERIES_STEPS } from '../../../events/event-store.service';

/** Fenêtre appliquée quand l'appelant n'en demande pas : les 30 derniers jours. */
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/**
 * Le plafond du classement.
 *
 * Dix par défaut. La valeur compte plus ici qu'ailleurs : les campagnes et les
 * pages d'entrée sont **fournies par le client** — n'importe quel `utm_source`
 * dans une URL en crée une — donc leur nombre n'est borné par rien. Ce qui tombe
 * hors du classement n'est pas perdu : il reste dans les totaux que la réponse
 * rend à côté.
 */
const MAX_LIMIT = 100;

/**
 * Les axes sur lesquels les paiements peuvent être rangés.
 *
 * Ensemble **fermé**, et c'est la propriété de sécurité du mécanisme : la
 * valeur vient d'une URL, elle est résolue ici puis dans le Core en référence de
 * colonne ou en clé liée. Aucune chaîne d'appelant n'atteint le SQL.
 */
export const ATTRIBUTION_AXES = [
  'campaign',
  'source',
  'referrer',
  'landing',
  'country',
  'browser',
  'os',
  'device',
] as const;

export type AttributionAxis = (typeof ATTRIBUTION_AXES)[number];

/**
 * Ce qu'on rend quand l'appelant ne demande rien : la carte Acquisition.
 *
 * Les axes d'audience — pays, navigateur, système, appareil — ne sont pas du
 * défaut parce qu'ils appartiennent à d'autres cartes. Chaque groupement est une
 * passe SQL de plus : les rendre tous par défaut ferait payer sept agrégations
 * à qui en affiche quatre.
 */
const DEFAULT_AXES = [
  'campaign',
  'source',
  'referrer',
  'landing',
] as const satisfies readonly AttributionAxis[];

/**
 * `GET /v1/projects/:projectId/revenue/attribution` — la fenêtre, les axes, la
 * coupe, et les filtres à venir.
 *
 * ## `axes` : on ne calcule que ce qui sera affiché
 *
 * Une liste séparée par des virgules, `?axes=campaign,source`. Le client demande
 * exactement ce qu'il montre, et le serveur ne paie que ces groupements-là. La
 * réponse ne porte alors **que** les clés demandées : rendre les autres vides
 * laisserait croire qu'elles ont été calculées et qu'il n'y a rien dedans.
 *
 * ## Il n'y a plus de `kind`
 *
 * Le paramètre choisissait le type de paiement additionné, parce qu'un paiement
 * déclenche plusieurs événements Stripe porteurs du même montant. L'affinage
 * fait à l'ingestion a rendu ces types **disjoints** : on les somme tous, et la
 * question « quelle part vient des renouvellements » se lit dans Stripe, pas
 * ici.
 *
 * ## Les quatre filtres ne font encore rien
 *
 * Ils sont **déclarés, validés, et sans effet** — c'est délibéré. La page aura
 * besoin de se filtrer entièrement (« tout ceci, mais pour la France »), et
 * poser la forme maintenant évite de rouvrir le contrat à ce moment-là. Les
 * livrer aujourd'hui doublerait la surface de test d'une fonctionnalité que rien
 * n'affiche.
 *
 * Un e2e vérifie qu'ils sont acceptés **et** qu'ils ne changent rien : c'est ce
 * qui empêchera de croire qu'ils agissent.
 *
 * `strictObject` comme partout : un paramètre inconnu rend 400 plutôt que d'être
 * ignoré. Sur une API de lecture, un filtre silencieusement écarté produit un
 * chiffre juste à une question que personne n'a posée.
 *
 * La fenêtre par défaut est de **trente** jours : un mois est la maille du
 * revenu, et sept jours ne montreraient qu'une fraction des renouvellements.
 */
export const revenueAttributionSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    axes: z
      .string()
      .optional()
      .transform((value) => value?.split(','))
      .pipe(z.array(z.enum(ATTRIBUTION_AXES)).min(1).optional())
      .transform((value) => value ?? [...DEFAULT_AXES]),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(10),
    country: z.string().length(2).optional(),
    landing: z.string().max(500).optional(),
    source: z.string().max(200).optional(),
    campaign: z.string().max(200).optional(),
  })
  .transform(({ from, to, ...rest }) => {
    const upper = to ?? new Date();

    return {
      from: from ?? new Date(upper.getTime() - DEFAULT_WINDOW_MS),
      to: upper,
      ...rest,
    };
  })
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête d'attribution du revenu, validée et résolue. */
export type RevenueAttributionDto = z.output<typeof revenueAttributionSchema>;

/**
 * Le nombre de mois suivis après l'acquisition.
 *
 * Six par défaut : c'est l'horizon sur lequel une décision d'acquisition se
 * juge, et la matrice tient encore à l'écran. Vingt-quatre au plus — au-delà,
 * la moitié des cellules serait vide sur un produit de moins de deux ans, et
 * une matrice à trous ne se lit pas.
 */
const MAX_DEPTH = 24;

/**
 * `GET /v1/projects/:projectId/revenue/cohorts` — la fenêtre des cohortes, et
 * la profondeur du suivi.
 *
 * La fenêtre borne les **mois d'acquisition** rendus, pas les paiements
 * observés : une cohorte de mars suivie jusqu'en septembre regarde forcément
 * au-delà de sa propre borne. Douze mois par défaut, parce qu'une cohorte se
 * juge sur un an.
 */
export const revenueCohortsSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(6),
  })
  .transform(({ depth, from, to }) => {
    const upper = to ?? new Date();
    const lower =
      from ??
      new Date(Date.UTC(upper.getUTCFullYear() - 1, upper.getUTCMonth(), 1));

    return { from: lower, to: upper, depth };
  })
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête de cohortes, validée et résolue. */
export type RevenueCohortsDto = z.output<typeof revenueCohortsSchema>;

/**
 * `GET /v1/projects/:projectId/revenue/movements` — une fenêtre, et rien
 * d'autre.
 *
 * Le grain est le **mois**, et il ne se choisit pas : un abonnement se
 * renouvelle à ce pas, et compter des départs à la semaine ferait apparaître des
 * creux de calendrier — quatre ou cinq renouvellements selon la semaine — pour
 * des variations qui n'ont pas eu lieu.
 *
 * Douze mois par défaut : la saisonnalité des renouvellements ne se voit pas sur
 * moins d'un an.
 */
export const revenueMovementsSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
  })
  .transform(({ from, to }) => {
    const upper = to ?? new Date();

    return {
      from:
        from ??
        new Date(Date.UTC(upper.getUTCFullYear() - 1, upper.getUTCMonth(), 1)),
      to: upper,
    };
  })
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête de mouvements d'abonnement, validée et résolue. */
export type RevenueMovementsDto = z.output<typeof revenueMovementsSchema>;

/**
 * `GET /v1/projects/:projectId/revenue/series` — le revenu dans le temps.
 *
 * ## Un pas, pas une fenêtre prédéfinie
 *
 * `?from&to&step=day|week|month`. La fenêtre reste celle de toutes les autres
 * routes — un `?period=30` aurait introduit une seconde façon de dire la
 * période, et le décalage de la page ne s'y serait plus exprimé.
 *
 * Le pas dit la granularité : un graphique de trente jours demande `day`, une
 * courbe d'un an demande `month`, et c'est la même route qui les sert. Le
 * défaut est `day`, qui est ce que la page affiche.
 *
 * ## Pourquoi cette route existe, alors que le client sait replier
 *
 * Il sait replier un compte de sessions, parce qu'il les a déjà. Une **somme
 * d'argent**, non : la redescendre entière ferait remonter tous les paiements
 * de la fenêtre pour les additionner dans un navigateur, et deux pages qui
 * referaient ce calcul finiraient par diverger. Le total de cette série égale
 * celui d'`/attribution` sur la même fenêtre, par construction — les deux lisent
 * les mêmes cinq types.
 */
export const revenueSeriesSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    step: z.enum(SERIES_STEPS).default('day'),
  })
  .transform(({ from, to, step }) => {
    const upper = to ?? new Date();

    return {
      from: from ?? new Date(upper.getTime() - DEFAULT_WINDOW_MS),
      to: upper,
      step,
    };
  })
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête de série de revenu, validée et résolue. */
export type RevenueSeriesDto = z.output<typeof revenueSeriesSchema>;

import { z } from 'zod';

import { sourceSchema } from './analytics';

/**
 * Ce que `/v1/projects/:projectId/revenue/*` promet.
 *
 * ## La règle qui prime sur la forme
 *
 * **Les montants ne sont pas transformés.** Ils sortent en centimes, dans la
 * devise que Stripe a enregistrée, sans conversion ni arrondi ni mélange. Un
 * client qui verrait ici un total différent de son tableau de bord Stripe
 * conclurait que c'est le nôtre qui ment — et il aurait raison, puisqu'il n'a
 * aucun moyen de trancher.
 *
 * C'est à l'affichage de diviser par cent, et seulement avec la devise sous les
 * yeux : toutes les devises n'ont pas deux décimales.
 */

/** La campagne d'acquisition, telle que le serveur l'a normalisée. */
export const campaignSchema = z.object({
  source: z.string().nullable(),
  medium: z.string().nullable(),
  name: z.string().nullable(),
});

export type Campaign = z.infer<typeof campaignSchema>;

/** Ce qu'une ligne de classement pèse, quel que soit l'axe. */
const revenueRow = {
  /** Le libellé de la ligne, tel qu'on l'affiche. */
  label: z.string(),
  /**
   * La devise ISO telle que Stripe la donne, ou `null`.
   *
   * Elle **sépare** les lignes, elle ne les convertit pas : une campagne qui a
   * encaissé des euros et des dollars produit deux lignes, et leur somme n'a
   * aucun sens sans taux de change.
   */
  currency: z.string().nullable(),
  /** En **centimes**, tels que Stripe les écrit. Jamais divisé ici. */
  amount: z.number(),
  /** Nombre de paiements comptés — voir `eventTypes`. */
  payments: z.number(),
  /** Visiteurs distincts derrière ces paiements. */
  visitors: z.number(),
};

/**
 * Une campagne d'acquisition et ce qu'elle a rapporté.
 *
 * ⚠️ **La campagne est celle de la première visite du visiteur**, pas de la
 * visite pendant laquelle il a payé. C'est un modèle d'attribution — *first
 * touch* — et il est assumé : c'est celui qui répond à « quelle campagne
 * m'amène des clients », là où la dernière visite répond à « quelle page a
 * conclu ».
 */
export const campaignRevenueSchema = z.object({
  ...revenueRow,
  campaign: campaignSchema,
});

export type CampaignRevenue = z.infer<typeof campaignRevenueSchema>;

/**
 * Une provenance et ce qu'elle a rapporté.
 *
 * Les referrers bruts sont **repliés** : `google.fr` et `google.com` ne font
 * qu'une ligne. Le repli se faisant après le classement, `visitors` est un
 * **majorant** — quelqu'un vu derrière deux referrers du même moteur y compte
 * deux fois. `payments` et `amount`, eux, sont exacts : un paiement n'appartient
 * qu'à une ligne.
 */
export const sourceRevenueSchema = z.object({
  ...revenueRow,
  source: sourceSchema,
});

export type SourceRevenue = z.infer<typeof sourceRevenueSchema>;

/** Le même total, pour ce qu'aucune valeur de l'axe ne revendique. */
export const unsourcedRevenueSchema = z.object({
  currency: z.string().nullable(),
  amount: z.number(),
  payments: z.number(),
  visitors: z.number(),
});

export type UnsourcedRevenue = z.infer<typeof unsourcedRevenueSchema>;

/**
 * Un axe, et les deux ensembles qui ne sont pas des restes.
 *
 * `rows` classe. `direct` porte les paiements de visiteurs **connus** qui n'ont
 * rien sur cet axe — arrivés sans campagne, sans referrer. `unattributed` porte
 * ceux qu'aucun parcours ne réclame : consentement refusé, identifiant jamais
 * posé, ou client antérieur à l'installation.
 *
 * Les afficher ensemble n'est pas une option de présentation : annoncer
 * « 12 k€ venus de Google » sans dire que 30 k€ ne sont rattachés à rien fait
 * lire une part comme un total.
 */
const breakdown = <Row extends z.ZodTypeAny>(row: Row) =>
  z.object({
    rows: z.array(row),
    direct: z.array(unsourcedRevenueSchema),
    unattributed: z.array(unsourcedRevenueSchema),
  });

/**
 * `GET /v1/projects/:projectId/revenue/attribution` — d'où vient l'argent.
 *
 * ## Quatre répartitions, une réponse
 *
 * Les mêmes paiements rangés par campagne, par provenance, par page d'entrée et
 * par pays. Quatre routes auraient demandé quatre allers-retours pour une seule
 * carte, et rien ne garantirait que leurs totaux s'accordent — un paiement
 * arrivé entre deux appels suffirait à les faire diverger.
 *
 * ## `eventTypes` est la définition du chiffre
 *
 * Un paiement déclenche plusieurs événements Stripe porteurs du même montant.
 * Ceux qui sont additionnés ici sont **disjoints par construction** — une
 * facture, une ligne — et la réponse les nomme, parce que c'est la seule façon
 * de réconcilier ce total avec le tableau de bord Stripe.
 */
export const revenueAttributionPageSchema = z.object({
  /** Borne incluse. */
  from: z.iso.datetime({ offset: true }),
  /** Borne exclue. */
  to: z.iso.datetime({ offset: true }),
  /** Les types d'événement réellement additionnés. */
  eventTypes: z.array(z.string()),
  campaigns: breakdown(campaignRevenueSchema),
  sources: breakdown(sourceRevenueSchema),
  landings: breakdown(z.object(revenueRow)),
  countries: breakdown(z.object(revenueRow)),
});

export type RevenueAttributionPage = z.infer<
  typeof revenueAttributionPageSchema
>;

/**
 * `POST /v1/projects/:projectId/revenue/sync` — ce que le rattrapage a fait.
 *
 * Quatre nombres, et le dernier n'est pas un échec : `skipped` compte les
 * factures déjà rejouées lors d'une resynchronisation précédente. Sa présence
 * est la preuve que l'opération est idempotente — relancer ne double rien.
 *
 * `customers` compte les paires client ↔ visiteur **nouvelles**. Chacune a
 * déclenché l'attribution rétroactive de ce que ce client avait déjà produit :
 * c'est le chiffre qui dit combien de revenu vient de retrouver une origine.
 */
export const syncReportSchema = z.object({
  customers: z.number(),
  subscriptions: z.number(),
  invoices: z.number(),
  skipped: z.number(),
});

export type SyncReport = z.infer<typeof syncReportSchema>;

/**
 * Une cohorte d'acquisition : ceux qui sont arrivés le même mois.
 *
 * ⚠️ **La courbe peut monter**, et ce n'est pas une anomalie. La cohorte est
 * celle de l'**acquisition**, pas de l'abonnement : quelqu'un vu en mars qui
 * s'abonne en juin entre dans la cohorte de mars et n'apparaît qu'en M+3. C'est
 * exactement ce qu'on veut voir — le délai entre la découverte et l'achat — là
 * où une cohorte d'abonnement part de cent pour cent par construction et le
 * masque.
 *
 * ⚠️ **`null` n'est pas zéro** dans `active` : c'est un mois qui n'est pas
 * écoulé, donc une cellule qu'aucune mesure ne couvre encore. Les confondre
 * dessine une falaise au bord de la matrice.
 *
 * ⚠️ L'état d'abonnement est une **approximation connue** : Stripe n'expose
 * aucun historique de statut, donc un abonnement suspendu puis repris compte
 * comme actif tout du long. Le prédicat ne voit que le début et la fin réelle.
 */
export const cohortSchema = z.object({
  /** Le mois de première visite, en UTC : `2026-03`. */
  month: z.string(),
  /** Clients dont la première visite tombe ce mois-là. */
  customers: z.number(),
  /** Ceux d'entre eux qui ont pris un abonnement, un jour, même résilié depuis. */
  converted: z.number(),
  /** Abonnés à la clôture de M+0, M+1, … M+`depth`. */
  active: z.array(z.number().nullable()),
});

export type Cohort = z.infer<typeof cohortSchema>;

/**
 * `GET /v1/projects/:projectId/revenue/cohorts` — la matrice de rétention.
 *
 * `unmeasured` n'est pas un détail de bas de page : c'est le nombre de clients
 * qu'aucune cohorte ne contient, faute de première visite connue — antérieurs à
 * l'installation, ou sans consentement. Une matrice qui ne couvre qu'un tiers
 * des clients ressemble, sans lui, à une matrice qui les couvre tous.
 */
export const cohortsPageSchema = z.object({
  /** Borne incluse : le premier mois de cohorte rendu. */
  from: z.iso.datetime({ offset: true }),
  /** Borne incluse : le dernier. */
  to: z.iso.datetime({ offset: true }),
  depth: z.number(),
  cohorts: z.array(cohortSchema),
  unmeasured: z.number(),
});

export type CohortsPage = z.infer<typeof cohortsPageSchema>;

/**
 * Le mouvement d'un mois : qui entre, qui sort, qui reste.
 *
 * ⚠️ **Aucun taux.** Le churn se divise d'au moins trois façons défendables —
 * par les actifs du début de mois, par leur moyenne, par la cohorte — et en
 * figer une ici priverait les autres de leurs termes. Le lecteur divise ce qu'il
 * veut par ce qu'il veut.
 *
 * ⚠️ `active` n'est pas `précédent + started − ended` : un abonnement commencé
 * et résilié dans le même mois compte dans les deux mouvements et dans aucun
 * solde. L'écart est réel, et le combler par un cumul en effacerait la cause.
 *
 * ⚠️ Une **pause** ne produit ni sortie ni entrée : Stripe n'expose aucun
 * historique de statut, et ce qui est stocké est un début et une fin réelle.
 */
export const movementSchema = z.object({
  /** Le mois UTC : `2026-03`. */
  month: z.string(),
  started: z.number(),
  ended: z.number(),
  active: z.number(),
});

export type Movement = z.infer<typeof movementSchema>;

/**
 * `GET /v1/projects/:projectId/revenue/movements` — le churn, mois par mois.
 *
 * Seuls les mois **clos** sont rendus : un mois en cours afficherait des
 * départs sans les entrées qui n'ont pas encore eu lieu, ce qui ressemble à une
 * hémorragie et n'en est pas une.
 */
export const movementsPageSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  movements: z.array(movementSchema),
});

export type MovementsPage = z.infer<typeof movementsPageSchema>;

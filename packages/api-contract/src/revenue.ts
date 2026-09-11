import { z } from 'zod';

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

/**
 * Ce qu'une campagne a rapporté.
 *
 * ⚠️ **La campagne est celle de la première visite du visiteur**, pas de la
 * visite pendant laquelle il a payé. C'est un modèle d'attribution — *first
 * touch* — et il est assumé : c'est celui qui répond à « quelle campagne me
 * rapporte des clients », là où la dernière visite répond à « quelle page a
 * conclu ».
 */
export const campaignRevenueSchema = z.object({
  campaign: campaignSchema,
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
  /** Nombre d'événements du type visé — voir `eventType`. */
  payments: z.number(),
  /** Visiteurs distincts derrière ces paiements. */
  visitors: z.number(),
});

export type CampaignRevenue = z.infer<typeof campaignRevenueSchema>;

/** Le même total, pour ce qu'aucune campagne ne revendique. */
export const unsourcedRevenueSchema = z.object({
  currency: z.string().nullable(),
  amount: z.number(),
  payments: z.number(),
  visitors: z.number(),
});

export type UnsourcedRevenue = z.infer<typeof unsourcedRevenueSchema>;

/** Les quatre questions de revenu, dans le vocabulaire du produit. */
export const REVENUE_KINDS = [
  'new',
  'recurring',
  'change',
  'one_time',
] as const;

export const revenueKindSchema = z.enum(REVENUE_KINDS);

export type RevenueKind = z.infer<typeof revenueKindSchema>;

/**
 * `GET /v1/projects/:projectId/revenue/campaigns` — le revenu croisé à
 * l'acquisition.
 *
 * ## Trois listes, et les deux dernières ne sont pas un reste
 *
 * `campaigns` classe ce qui vient d'une campagne. `direct` porte les paiements
 * de visiteurs **connus** venus sans campagne. `unattributed` porte ceux
 * qu'aucun parcours ne réclame : consentement refusé, identifiant jamais posé,
 * ou client antérieur à l'installation.
 *
 * Les afficher ensemble n'est pas une option de présentation, c'est la
 * condition pour que le classement soit lisible : annoncer « 12 k€ venus de
 * Google » sans dire que 30 k€ ne sont rattachés à rien fait lire une part
 * comme un total.
 *
 * ## `eventType` est la définition du chiffre
 *
 * Un paiement déclenche plusieurs événements Stripe portant tous le même
 * montant ; le classement en vise donc **un seul**, choisi par `kind`. Le type
 * retenu est rendu pour que le chiffre affiché ne soit jamais d'origine
 * devinable — c'est la même exigence que pour un MRR dont on nomme la formule.
 *
 * Les quatre `kind` ne s'additionnent pas entre eux : un abonnement pris au
 * checkout produit à la fois un `new` et un `one_time`.
 */
export const campaignRevenuePageSchema = z.object({
  /** Borne incluse. */
  from: z.iso.datetime({ offset: true }),
  /** Borne exclue. */
  to: z.iso.datetime({ offset: true }),
  kind: revenueKindSchema,
  /** Le type d'événement réellement additionné. */
  eventType: z.string(),
  campaigns: z.array(campaignRevenueSchema),
  direct: z.array(unsourcedRevenueSchema),
  unattributed: z.array(unsourcedRevenueSchema),
});

export type CampaignRevenuePage = z.infer<typeof campaignRevenuePageSchema>;

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

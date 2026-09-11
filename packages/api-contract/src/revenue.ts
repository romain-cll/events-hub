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

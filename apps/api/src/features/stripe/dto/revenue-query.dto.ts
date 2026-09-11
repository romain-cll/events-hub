import { z } from 'zod';

/** Fenêtre appliquée quand l'appelant n'en demande pas : les 30 derniers jours. */
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/**
 * Ce qu'on additionne, et pourquoi c'est l'appelant qui le choisit.
 *
 * **Un seul paiement produit plusieurs événements Stripe** — un checkout par
 * carte en produit couramment quatre, tous porteurs d'un montant. Additionner
 * « tout ce qui porte un montant » compterait le même euro quatre fois, le
 * résultat resterait plausible, et rien ne le signalerait.
 *
 * Le classement vise donc **un type précis**, et le type dépend de la question.
 * Les quatre valeurs ci-dessous sont ces questions, dans le vocabulaire du
 * produit — pas dans celui de Stripe, qui n'a pas à fuir dans une URL publique.
 *
 * Elles ne s'additionnent pas entre elles, et c'est pour ça qu'on n'en rend
 * qu'une à la fois : un abonnement pris au checkout produit à la fois un
 * `started` et un paiement ponctuel, et leur somme doublerait ce client.
 */
export const REVENUE_KINDS = [
  'new',
  'recurring',
  'change',
  'one_time',
] as const;

export type RevenueKind = (typeof REVENUE_KINDS)[number];

/**
 * Le plafond du classement.
 *
 * Dix comme les autres classements. La valeur compte plus ici qu'ailleurs :
 * les campagnes sont **fournies par le client** — n'importe quel `utm_source`
 * dans une URL en crée une — donc leur nombre n'est borné par rien. Ce qui
 * tombe hors du classement n'est pas perdu pour autant : il reste dans le total
 * de la fenêtre, que la réponse rend à côté.
 */
const MAX_LIMIT = 100;

/**
 * `GET /v1/projects/:projectId/revenue/campaigns` — la fenêtre, la question, la
 * coupe.
 *
 * `strictObject` comme les lectures d'analytics : un paramètre inconnu rend 400
 * plutôt que d'être ignoré. Sur une API de lecture, un filtre silencieusement
 * écarté produit un chiffre juste à une question que personne n'a posée.
 *
 * La fenêtre par défaut est de **trente** jours, et pas sept comme l'analytics :
 * un mois est la maille du revenu — un abonnement se renouvelle à ce pas — et
 * sept jours ne montreraient qu'une fraction des paiements récurrents.
 */
export const revenueCampaignsSchema = z
  .strictObject({
    from: instant.optional(),
    to: instant.optional(),
    kind: z.enum(REVENUE_KINDS).default('new'),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(10),
  })
  .transform(({ kind, limit, from, to }) => {
    const upper = to ?? new Date();

    return {
      from: from ?? new Date(upper.getTime() - DEFAULT_WINDOW_MS),
      to: upper,
      kind,
      limit,
    };
  })
  .refine(({ from, to }) => from <= to, {
    message: '`from` doit être antérieur ou égal à `to`.',
  });

/** Requête de revenu par campagne, validée et résolue. */
export type RevenueCampaignsDto = z.output<typeof revenueCampaignsSchema>;

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
      new Date(
        Date.UTC(upper.getUTCFullYear() - 1, upper.getUTCMonth(), 1),
      );

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

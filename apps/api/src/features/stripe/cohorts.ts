/**
 * Les cohortes d'acquisition, calculées hors de toute base.
 *
 * Trois lectures y mènent — les clients connus, leurs abonnements, leur
 * première visite — et le croisement, lui, n'est qu'une question d'arithmétique
 * de calendrier. L'écrire en SQL demanderait de joindre des tables que deux
 * modules différents possèdent ; l'écrire ici le rend éprouvable sans Postgres,
 * et c'est bien le calcul qu'on veut éprouver, pas la jointure.
 */

/** Un client, réduit à ce qu'une cohorte lui demande. */
export interface CohortCustomer {
  /**
   * Sa première visite, ou `null` s'il n'en a aucune de connue.
   *
   * `null` est le cas d'un client antérieur à l'installation, ou d'un
   * consentement jamais donné. Il n'a pas de cohorte, et lui en attribuer une
   * fausserait celles qui l'entourent.
   */
  firstVisit: Date | null;
  /** Ses périodes d'abonnement, telles que Stripe les décrit. */
  subscriptions: SubscriptionSpan[];
}

/**
 * Une période d'abonnement, bornée par deux dates brutes.
 *
 * ⚠️ C'est une **approximation**, et elle est connue : Stripe n'expose aucun
 * historique de statut, donc un abonnement suspendu deux mois puis repris
 * compte ici comme actif tout du long. Le prédicat ne voit que le début et la
 * fin ; les pauses et les impayés traversés lui échappent.
 *
 * `endedAt` est la **fin réelle** du service, jamais la date de la demande de
 * résiliation — les deux sont séparées d'une période entière quand on résilie
 * en fin de cycle, et prendre la seconde avancerait tous les départs d'un mois.
 */
export interface SubscriptionSpan {
  startDate: Date;
  endedAt: Date | null;
}

/** Une cohorte : ceux qui sont arrivés le même mois. */
export interface Cohort {
  /** Le mois de première visite, en UTC : `2026-03`. */
  month: string;
  /** Clients dont la première visite tombe ce mois-là. */
  customers: number;
  /** Ceux d'entre eux qui ont pris un abonnement, un jour, même résilié depuis. */
  converted: number;
  /**
   * Abonnés à la **clôture** de M+0, M+1, … M+profondeur.
   *
   * ⚠️ Cette courbe peut **monter**, et ce n'est pas une anomalie : la cohorte
   * est celle de l'acquisition, pas de l'abonnement. Quelqu'un vu en mars qui
   * s'abonne en juin entre dans la cohorte de mars et n'apparaît qu'en M+3.
   * C'est précisément ce qu'on veut voir — le délai entre la découverte et
   * l'achat — et c'est ce qu'une cohorte d'abonnement, elle, masque en partant
   * de cent pour cent par construction.
   *
   * `null` là où le mois n'est pas écoulé : une cellule à zéro et une cellule
   * qui n'a pas encore eu lieu ne se lisent pas pareil, et les confondre
   * dessine une falaise au bord de la matrice.
   */
  active: (number | null)[];
}

export interface CohortsReading {
  cohorts: Cohort[];
  /**
   * Les clients sans première visite connue.
   *
   * Ils ne sont dans aucune cohorte, et le dire est la moitié de l'honnêteté de
   * cette lecture : sans ce nombre, une matrice qui ne couvre qu'un tiers des
   * clients ressemble à une matrice qui les couvre tous.
   */
  unmeasured: number;
}

/** Le mois UTC d'un instant, sous la forme `2026-03`. */
function monthOf(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** L'instant qui **clôt** le mois `offset` mois après celui-ci — borne exclue. */
function closeOf(month: string, offset: number): Date {
  const [year, index] = month.split('-').map(Number);

  return new Date(Date.UTC(year, index + offset, 1));
}

/**
 * L'abonnement couvrait-il encore l'instant `at` ?
 *
 * Bornes brutes, sans rien déduire : commencé avant, pas encore terminé. Un
 * abonnement sans fin est en cours, ce qui est la lecture littérale de
 * `ended_at IS NULL` et la seule que Stripe autorise.
 */
function covers({ startDate, endedAt }: SubscriptionSpan, at: Date): boolean {
  return startDate < at && (endedAt === null || endedAt >= at);
}

/** Les mois UTC de `from` à `to`, bornes comprises, sans trou. */
function monthsBetween(from: Date, to: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1),
  );

  while (cursor <= to) {
    months.push(monthOf(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

/**
 * La matrice, mois par mois.
 *
 * Tous les mois de la fenêtre sont rendus, **y compris les vides** : un axe de
 * temps troué se lit comme un axe continu, et fait passer un mois sans
 * acquisition pour un mois qui n'a pas existé.
 *
 * `now` est passé plutôt que lu : c'est lui qui décide de ce qui n'est pas
 * encore observable, et une fonction dont le résultat dépend de l'horloge ne
 * s'éprouve pas.
 */
export function cohortsOf(
  customers: CohortCustomer[],
  { from, to, depth, now }: { from: Date; to: Date; depth: number; now: Date },
): CohortsReading {
  const byMonth = new Map<string, CohortCustomer[]>();
  let unmeasured = 0;

  for (const customer of customers) {
    if (!customer.firstVisit) {
      unmeasured += 1;

      continue;
    }

    const month = monthOf(customer.firstVisit);
    const lot = byMonth.get(month);

    if (lot) lot.push(customer);
    else byMonth.set(month, [customer]);
  }

  const cohorts = monthsBetween(from, to).map((month) => {
    const lot = byMonth.get(month) ?? [];

    return {
      month,
      customers: lot.length,
      converted: lot.filter((customer) => customer.subscriptions.length > 0)
        .length,
      active: Array.from({ length: depth + 1 }, (_, offset) => {
        const close = closeOf(month, offset);

        // Le mois n'est pas clos : on ne sait pas encore, et zéro serait un
        // mensonge de plus que `null`.
        if (close > now) return null;

        return lot.filter((customer) =>
          customer.subscriptions.some((span) => covers(span, close)),
        ).length;
      }),
    };
  });

  return { cohorts, unmeasured };
}

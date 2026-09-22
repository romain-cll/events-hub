import type { SubscriptionSpan } from './cohorts';

/**
 * Les entrées et les sorties, mois par mois — le churn, sans le nommer un taux.
 *
 * ## Trois nombres bruts, et pas de division
 *
 * `started`, `ended`, `active`. Le taux de churn se refait par une division, et
 * c'est au lecteur de la faire : il y a au moins trois dénominateurs défendables
 * — les actifs en début de mois, la moyenne du mois, les actifs de la cohorte —
 * et en figer un ici obligerait tous les autres à recalculer depuis un chiffre
 * dont ils ne pourraient plus extraire les termes.
 *
 * C'est la même posture que `durationMs`, absent de la ligne de session parce
 * que ses deux bornes y sont.
 *
 * ## Ce que la mesure ne voit pas
 *
 * Les dates brutes de Stripe, et rien d'autre. Un abonnement suspendu puis
 * repris ne produit ni sortie ni entrée : Stripe n'expose aucun historique de
 * statut, et ce que nous stockons est un début et une fin. C'est une
 * approximation connue, pas un oubli.
 */
export interface Movement {
  /** Le mois UTC : `2026-03`. */
  month: string;
  /** Abonnements dont le service a **commencé** dans le mois. */
  started: number;
  /** Abonnements dont le service a **pris fin** dans le mois. */
  ended: number;
  /**
   * Abonnements en cours à la **clôture** du mois.
   *
   * Ce n'est pas `précédent + started − ended` : un abonnement commencé et
   * résilié dans le même mois compte dans les deux mouvements et dans aucun
   * solde. L'écart entre les deux lectures est réel, et le masquer par un
   * cumul en ferait disparaître la cause.
   */
  active: number;
}

/** Le mois UTC d'un instant. */
function monthOf(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** L'instant qui clôt ce mois — borne exclue. */
function closeOf(month: string): Date {
  const [year, index] = month.split('-').map(Number);

  return new Date(Date.UTC(year, index, 1));
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
 * Le mouvement de chaque mois de la fenêtre.
 *
 * Tous les mois sont rendus, y compris les vides : un axe de temps troué se lit
 * comme un axe continu. `now` borne ce qui est observable — un mois à venir ne
 * rend rien plutôt que des zéros qui ressembleraient à une hémorragie.
 */
export function movementsOf(
  spans: SubscriptionSpan[],
  { from, to, now }: { from: Date; to: Date; now: Date },
): Movement[] {
  return monthsBetween(from, to)
    .filter((month) => closeOf(month) <= now)
    .map((month) => {
      const close = closeOf(month);

      return {
        month,
        started: spans.filter((span) => monthOf(span.startDate) === month)
          .length,
        ended: spans.filter(
          (span) => span.endedAt !== null && monthOf(span.endedAt) === month,
        ).length,
        active: spans.filter(
          (span) =>
            span.startDate < close &&
            (span.endedAt === null || span.endedAt >= close),
        ).length,
      };
    });
}

import type { ProjectedItem } from './subscription-projection';

/**
 * Ce qu'il faut d'un item pour le mensualiser, et rien de plus.
 *
 * Un sous-ensemble plutôt que `ProjectedItem` entier : la fonction sert aussi
 * aux lignes relues en base au moment de les remplacer, qui ne portent que ces
 * quatre colonnes. Exiger l'objet complet obligerait à en lire six de plus pour
 * les jeter aussitôt.
 */
export type Priced = Pick<
  ProjectedItem,
  'unitAmount' | 'quantity' | 'interval' | 'intervalCount'
>;

/**
 * Ce qu'un abonnement vaut **par mois**, et rien d'autre.
 *
 * ## La formule est celle de Stripe, et c'est délibéré
 *
 * `unit_amount × quantity`, ramené au mois : un annuel divisé par douze, un
 * trimestriel par trois. C'est ce que Stripe Billing calcule pour son propre
 * MRR, et le reprendre à l'identique est la seule façon de ne pas avoir à
 * expliquer un écart entre deux tableaux de bord.
 *
 * ## Ce qu'elle n'applique pas
 *
 * Ni remise, ni taxe, ni proration. Ce sont les exclusions de la formule
 * d'origine, pas des oublis : elles dépendent de la facture, pas de
 * l'abonnement, et les intégrer ici demanderait de deviner ce qui sera
 * réellement facturé le mois prochain.
 *
 * L'écran qui affichera ce chiffre doit le dire à côté. Un MRR dont personne ne
 * peut nommer les exclusions est un chiffre qu'on ne peut pas réconcilier.
 *
 * ## Un prix mesuré à l'usage compte pour zéro
 *
 * `unitAmount` à `null` n'est pas une donnée manquante : c'est un prix dont le
 * montant n'existe qu'une fois la consommation connue, sur la facture. Lui
 * inventer une valeur gonflerait le MRR d'un chiffre que rien ne soutient ; le
 * compter zéro le sous-estime, et **c'est le bon sens de l'erreur** — une
 * lecture peut signaler ce qu'elle ignore, elle ne peut pas retirer ce qu'on a
 * inventé.
 *
 * ## Des centimes entiers
 *
 * Arrondi à l'unité, une fois, à la fin. Un tiers de centime n'existe pas, et
 * laisser un flottant courir dans une donnée comptable le ferait dériver à
 * chaque addition — la somme de trois abonnements annuels ne tomberait plus sur
 * le même nombre selon l'ordre où on les additionne.
 */

/** Combien de mois dure une période, selon la cadence que Stripe écrit. */
const MONTHS_PER_INTERVAL: Record<string, number> = {
  day: 1 / 30.4375,
  week: 7 / 30.4375,
  month: 1,
  year: 12,
};

export function monthlyAmountOf(items: Priced[]): number {
  const total = items.reduce((sum, item) => {
    if (item.unitAmount === null) return sum;

    const months =
      (MONTHS_PER_INTERVAL[item.interval ?? ''] ?? 0) *
      (item.intervalCount ?? 1);

    // Une cadence inconnue ou absente vaut zéro plutôt que de diviser par elle :
    // un prix non récurrent peut vivre dans un abonnement, et il n'a pas de
    // montant mensuel.
    if (months <= 0) return sum;

    return sum + (item.unitAmount * (item.quantity ?? 1)) / months;
  }, 0);

  return Math.round(total);
}

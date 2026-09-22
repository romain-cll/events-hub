import { monthlyAmountOf } from './monthly-amount';
import type { ProjectedItem } from './subscription-projection';

/**
 * La mensualisation, et les quatre façons de s'y tromper.
 *
 * Aucune base ici : ce qui est éprouvé est une formule, et une erreur y
 * produirait un MRR plausible et faux — le genre de chiffre qu'un client
 * compare à son tableau de bord Stripe avant de conclure que c'est le nôtre qui
 * ment.
 */

const item = (overrides: Partial<ProjectedItem> = {}): ProjectedItem => ({
  stripeId: 'si_1',
  priceId: 'price_1',
  productId: 'prod_1',
  quantity: 1,
  unitAmount: 1200,
  currency: 'eur',
  interval: 'month',
  intervalCount: 1,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  ...overrides,
});

describe('monthlyAmountOf', () => {
  it('ramène chaque cadence au mois', () => {
    expect(monthlyAmountOf([item()])).toBe(1200);
    // 12 000 par an, c'est 1 000 par mois — et c'est la division qui fait tout
    // l'intérêt du calcul : sans elle, un client annuel pèserait douze fois son
    // poids dans le MRR du mois où il paie.
    expect(
      monthlyAmountOf([item({ interval: 'year', unitAmount: 12_000 })]),
    ).toBe(1000);
    // Trimestriel : Stripe l'écrit `month` × 3, jamais `quarter`.
    expect(
      monthlyAmountOf([
        item({ interval: 'month', intervalCount: 3, unitAmount: 3000 }),
      ]),
    ).toBe(1000);
  });

  it('mensualise les cadences courtes sur l’année, pas sur quatre semaines', () => {
    // 30,4375 jours par mois — la moyenne d'une année bissextile comprise. Un
    // mois à 28 jours ferait un MRR qui monte en février.
    expect(monthlyAmountOf([item({ interval: 'week', unitAmount: 700 })])).toBe(
      3044,
    );
    expect(monthlyAmountOf([item({ interval: 'day', unitAmount: 100 })])).toBe(
      3044,
    );
  });

  it('additionne les lignes et multiplie par la quantité', () => {
    // Un abonnement B2B en porte plusieurs : un forfait, des places, un module.
    expect(
      monthlyAmountOf([
        item({ unitAmount: 1000, quantity: 3 }),
        item({ stripeId: 'si_2', unitAmount: 500 }),
      ]),
    ).toBe(3500);
  });

  it('compte zéro pour un prix mesuré à l’usage', () => {
    // Son montant n'existe qu'une fois la consommation connue. Lui en inventer
    // un gonflerait le MRR d'un chiffre que rien ne soutient — et une lecture
    // peut signaler ce qu'elle ignore, elle ne peut pas retirer ce qu'on a
    // inventé.
    expect(
      monthlyAmountOf([
        item({ unitAmount: null, interval: null, intervalCount: null }),
        item({ stripeId: 'si_2', unitAmount: 900 }),
      ]),
    ).toBe(900);
  });

  it('ignore une ligne sans cadence plutôt que de diviser par rien', () => {
    // Un prix non récurrent peut vivre dans un abonnement. Il n'a pas de montant
    // mensuel, et le traiter comme mensuel le compterait douze fois par an.
    expect(
      monthlyAmountOf([item({ interval: null, intervalCount: null })]),
    ).toBe(0);
  });

  it('arrondit une fois, à la fin', () => {
    // Trois annuels à 100 € : 100/12 ne tombe pas juste, et arrondir chaque
    // ligne ferait dépendre le total de l'ordre des lignes.
    expect(
      monthlyAmountOf([
        item({ interval: 'year', unitAmount: 10_000 }),
        item({ stripeId: 'si_2', interval: 'year', unitAmount: 10_000 }),
        item({ stripeId: 'si_3', interval: 'year', unitAmount: 10_000 }),
      ]),
    ).toBe(2500);
  });
});

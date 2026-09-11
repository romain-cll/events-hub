import type { SubscriptionSpan } from './cohorts';
import { movementsOf } from './movements';

/**
 * Les entrées et les sorties, et le piège du solde.
 *
 * Ce qui est éprouvé ici n'est pas une somme : c'est le fait qu'`active` **n'est
 * pas** le cumul des mouvements, et qu'un mois non clos ne se rend pas.
 */

const MAINTENANT = new Date('2026-09-15T00:00:00.000Z');

const FENETRE = {
  from: new Date('2026-03-01T00:00:00.000Z'),
  to: new Date('2026-05-31T00:00:00.000Z'),
  now: MAINTENANT,
};

const abonnement = (
  startDate: string,
  endedAt: string | null = null,
): SubscriptionSpan => ({
  startDate: new Date(startDate),
  endedAt: endedAt === null ? null : new Date(endedAt),
});

describe('movementsOf', () => {
  it('compte les entrées et les sorties du mois où elles tombent', () => {
    const movements = movementsOf(
      [
        abonnement('2026-03-02T00:00:00.000Z'),
        abonnement('2026-03-20T00:00:00.000Z', '2026-04-10T00:00:00.000Z'),
      ],
      FENETRE,
    );

    expect(movements).toEqual([
      { month: '2026-03', started: 2, ended: 0, active: 2 },
      { month: '2026-04', started: 0, ended: 1, active: 1 },
      { month: '2026-05', started: 0, ended: 0, active: 1 },
    ]);
  });

  it('ne fait pas d’`active` le cumul des mouvements', () => {
    const movements = movementsOf(
      [abonnement('2026-03-05T00:00:00.000Z', '2026-03-25T00:00:00.000Z')],
      FENETRE,
    );

    // Entré et sorti dans le même mois : il compte dans les deux mouvements et
    // dans aucun solde. Un cumul afficherait zéro partout et effacerait
    // l'essai — qui est exactement ce qu'on veut voir.
    expect(movements[0]).toEqual({
      month: '2026-03',
      started: 1,
      ended: 1,
      active: 0,
    });
  });

  it('ne rend pas un mois qui n’est pas clos', () => {
    const movements = movementsOf([abonnement('2026-08-01T00:00:00.000Z')], {
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-10-31T00:00:00.000Z'),
      now: MAINTENANT,
    });

    // Septembre est en cours : le rendre montrerait des départs sans les
    // entrées qui n'ont pas encore eu lieu, ce qui ressemble à une hémorragie.
    expect(movements.map((mois) => mois.month)).toEqual(['2026-08']);
  });

  it('rend les mois vides plutôt que de les sauter', () => {
    const movements = movementsOf([], FENETRE);

    expect(movements).toHaveLength(3);
    expect(movements[1]).toMatchObject({ started: 0, ended: 0, active: 0 });
  });
});

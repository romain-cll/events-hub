import { cohortsOf, type CohortCustomer } from './cohorts';

/**
 * L'arithmétique de calendrier, et les quatre pièges qu'elle cache.
 *
 * Aucune base ici : ce qui est éprouvé est le **sens** des cellules — ce qu'un
 * zéro veut dire, ce qu'un `null` veut dire, et ce qu'une courbe qui monte veut
 * dire. Une erreur y produirait une matrice plausible et fausse, que rien
 * d'autre n'attraperait.
 */

const MAINTENANT = new Date('2026-09-15T00:00:00.000Z');

const FENETRE = {
  from: new Date('2026-03-01T00:00:00.000Z'),
  to: new Date('2026-05-31T23:59:59.999Z'),
  depth: 3,
  now: MAINTENANT,
};

const client = (
  firstVisit: string | null,
  spans: [string, string | null][] = [],
): CohortCustomer => ({
  firstVisit: firstVisit === null ? null : new Date(firstVisit),
  subscriptions: spans.map(([startDate, endedAt]) => ({
    startDate: new Date(startDate),
    endedAt: endedAt === null ? null : new Date(endedAt),
  })),
});

describe('cohortsOf', () => {
  it('regroupe par mois UTC de première visite', () => {
    const { cohorts } = cohortsOf(
      [
        client('2026-03-02T23:00:00.000Z', [
          ['2026-03-02T23:30:00.000Z', null],
        ]),
        client('2026-03-31T23:59:00.000Z', [
          ['2026-04-01T10:00:00.000Z', null],
        ]),
        client('2026-04-01T00:00:00.000Z'),
      ],
      FENETRE,
    );

    // Le 31 mars à 23h59 UTC est en mars, quelle que soit l'heure locale de qui
    // regarde. Le fuseau du lecteur est une décision d'affichage, et la prendre
    // ici ferait changer une cohorte selon le pays de qui ouvre la page.
    expect(
      cohorts.map((cohorte) => [cohorte.month, cohorte.customers]),
    ).toEqual([
      ['2026-03', 2],
      ['2026-04', 1],
      ['2026-05', 0],
    ]);
  });

  it('rend les mois vides plutôt que de les sauter', () => {
    const { cohorts } = cohortsOf(
      [client('2026-05-04T00:00:00.000Z')],
      FENETRE,
    );

    // Un axe de temps troué se lit comme un axe continu : sans mars et avril à
    // zéro, un mois sans acquisition passerait pour un mois qui n'a pas existé.
    expect(cohorts).toHaveLength(3);
    expect(cohorts[0]).toMatchObject({ month: '2026-03', customers: 0 });
  });

  it('compte l’abonné à la clôture du mois, et pas après sa résiliation', () => {
    const { cohorts } = cohortsOf(
      [
        client('2026-03-05T00:00:00.000Z', [
          ['2026-03-05T00:00:00.000Z', '2026-04-20T00:00:00.000Z'],
        ]),
      ],
      FENETRE,
    );

    // Actif à la clôture de mars et à celle d'avril — il part le 20 avril, donc
    // il n'est plus là au 1er mai. `ended_at` est la fin **réelle** du service,
    // jamais la date de la demande : prendre celle-ci avancerait le départ d'une
    // période entière.
    expect(cohorts[0].active).toEqual([1, 0, 0, 0]);
  });

  it('laisse monter la courbe quand la conversion est tardive', () => {
    const { cohorts } = cohortsOf(
      [
        client('2026-03-05T00:00:00.000Z', [
          ['2026-05-02T00:00:00.000Z', null],
        ]),
      ],
      FENETRE,
    );

    // Vu en mars, abonné en mai : il n'apparaît qu'en M+2. Ce n'est pas une
    // anomalie de la mesure, c'est le délai entre la découverte et l'achat — et
    // c'est précisément ce qu'une cohorte d'abonnement masque en partant de
    // cent pour cent.
    expect(cohorts[0]).toMatchObject({
      customers: 1,
      converted: 1,
      active: [0, 0, 1, 1],
    });
  });

  it('ne mesure pas un mois qui n’est pas écoulé', () => {
    const { cohorts } = cohortsOf(
      [
        client('2026-08-10T00:00:00.000Z', [
          ['2026-08-10T00:00:00.000Z', null],
        ]),
      ],
      {
        ...FENETRE,
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-09-30T00:00:00.000Z'),
      },
    );

    // Août est clos, septembre non — on est le 15. Un zéro dirait « personne »
    // là où la réponse est « pas encore », et dessinerait une falaise au bord de
    // la matrice.
    expect(cohorts[0].active).toEqual([1, null, null, null]);
    expect(cohorts[1].active).toEqual([null, null, null, null]);
  });

  it('sort de la matrice le client dont on ne connaît aucune visite', () => {
    const { cohorts, unmeasured } = cohortsOf(
      [
        client(null, [['2026-03-01T00:00:00.000Z', null]]),
        client('2026-03-05T00:00:00.000Z'),
      ],
      FENETRE,
    );

    // Un abonné antérieur à l'installation n'a pas de cohorte, et lui en
    // inventer une fausserait celles qui l'entourent. Le compter à part est la
    // moitié de l'honnêteté de cette lecture.
    expect(unmeasured).toBe(1);
    expect(cohorts[0]).toMatchObject({ customers: 1, converted: 0 });
  });

  it('compte un client une fois, même avec deux abonnements', () => {
    const { cohorts } = cohortsOf(
      [
        client('2026-03-05T00:00:00.000Z', [
          ['2026-03-05T00:00:00.000Z', '2026-03-20T00:00:00.000Z'],
          ['2026-03-25T00:00:00.000Z', null],
        ]),
      ],
      FENETRE,
    );

    // Un client B2B en tient plusieurs. La cellule compte des **clients**, pas
    // des abonnements : sinon une montée en gamme ressemblerait à une
    // acquisition.
    expect(cohorts[0].active).toEqual([1, 1, 1, 1]);
  });
});

import { decideVisitorCookie } from './visitor-cookie';

/**
 * Le tri-état du consentement, et lui seul.
 *
 * C'est ici que vit la totalité de la bascule entre les deux modes : le reste
 * du chemin ne fait que transporter ce que cette fonction décide. Elle est pure,
 * donc elle se lit en entier dans ses cas.
 */

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const AUTRE = '9f8b7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c';

const entete = (valeur: string) => `__Host-eh_vid=${valeur}`;

describe('decideVisitorCookie — sans signal', () => {
  it('ne pose rien et ne réclame rien quand il n’y a pas de cookie', () => {
    expect(decideVisitorCookie(undefined, undefined)).toEqual({
      visitorId: undefined,
    });
  });

  it('honore un cookie déjà posé sans rien réécrire', () => {
    // L'absence de signal n'est pas un refus : le cookie *est* la trace d'un
    // consentement antérieur. Confondre les deux ferait perdre son identité à
    // tout visiteur d'un site qui ne câble pas le signal.
    const decision = decideVisitorCookie(entete(ID), undefined);

    expect(decision.visitorId).toBe(ID);
    expect(decision.setCookie).toBeUndefined();
    expect(decision.visitorIdJustGranted).toBeUndefined();
  });
});

describe('decideVisitorCookie — consentement accordé', () => {
  it('forge un identifiant et signale la bascule', () => {
    const decision = decideVisitorCookie(undefined, true);

    expect(decision.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // C'est cet événement-là, et lui seul, qui recolle la visite en cours.
    expect(decision.visitorIdJustGranted).toBe(true);
  });

  it('porte les attributs sans lesquels le cookie n’existerait pas', () => {
    const { setCookie } = decideVisitorCookie(undefined, true);

    // `Partitioned` : sans lui Safari et Firefox le refusent, il ne serait pas
    // raboté mais bloqué. `SameSite=None` : la requête est intersite par
    // construction. `Secure` : imposé par les deux autres et par `__Host-`.
    expect(setCookie).toContain('Partitioned');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');
    // 13 mois : la durée recommandée pour un traceur, consentie ou non. Le
    // plafond technique des navigateurs (400 jours) n'est pas le critère.
    expect(setCookie).toContain(`Max-Age=${395 * 24 * 60 * 60}`);
  });

  it('n’écrit rien quand l’identifiant est déjà posé', () => {
    const decision = decideVisitorCookie(entete(ID), true);

    expect(decision.visitorId).toBe(ID);
    // Le cœur des 13 mois : ne pas réécrire, sinon l'échéance se recharge à
    // chaque événement et la durée ne décrit plus rien. Le cookie expire donc
    // 13 mois après le jour de l'acceptation, pas 13 mois après la dernière
    // visite.
    expect(decision.setCookie).toBeUndefined();
    // Pas une bascule : le visiteur consentait déjà à l'événement précédent.
    expect(decision.visitorIdJustGranted).toBeUndefined();
  });
});

describe('decideVisitorCookie — consentement retiré', () => {
  it('efface le cookie et rend l’identifiant sortant', () => {
    const decision = decideVisitorCookie(entete(ID), false);

    expect(decision.visitorId).toBeUndefined();
    expect(decision.retiredVisitorId).toBe(ID);
    expect(decision.setCookie).toContain('Max-Age=0');
  });

  it('ne répond rien à qui n’avait pas de cookie', () => {
    // Sinon l'immense majorité des réponses porteraient un `Set-Cookie`
    // d'effacement pour un cookie qui n'a jamais existé.
    expect(decideVisitorCookie(undefined, false)).toEqual({});
  });
});

describe('decideVisitorCookie — la lecture de l’en-tête', () => {
  it('trouve le cookie au milieu des autres', () => {
    expect(
      decideVisitorCookie(`a=1; ${entete(ID)}; b=2`, undefined).visitorId,
    ).toBe(ID);
  });

  it('ne confond pas un cookie dont le nom est un suffixe du sien', () => {
    expect(
      decideVisitorCookie(`autre__Host-eh_vid=${AUTRE}`, undefined).visitorId,
    ).toBeUndefined();
  });

  it('ignore une valeur qui n’a pas la forme attendue', () => {
    // La valeur revient du navigateur du visiteur : n'importe qui peut y mettre
    // n'importe quoi. Ce n'est pas une frontière de sécurité — choisir sa
    // propre identité n'affecte que soi — mais du bruit n'a rien à faire dans
    // l'espace des identifiants.
    expect(
      decideVisitorCookie(entete('nimporte-quoi'), undefined).visitorId,
    ).toBeUndefined();
  });

  it('en forge un neuf plutôt que d’honorer une valeur invalide', () => {
    const decision = decideVisitorCookie(entete('nimporte-quoi'), true);

    expect(decision.visitorId).not.toBe('nimporte-quoi');
    expect(decision.visitorIdJustGranted).toBe(true);
  });
});

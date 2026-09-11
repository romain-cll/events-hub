import { decideOptOut } from './opt-out';

/**
 * L'opposition, et les trois façons dont elle arrive.
 *
 * Fonction pure : ni base, ni réseau. Ce qui se joue ici est la différence entre
 * « n'a rien dit » et « a dit non » — la confondre effacerait l'opposition de
 * tous les visiteurs au premier événement d'un site qui ne câble pas le signal,
 * exactement comme pour le consentement.
 */

const entete = (valeur: string) => `autre=1; __Host-eh_optout=${valeur}; x=2`;

describe('decideOptOut — sans signal', () => {
  it('laisse passer quand il n’y a rien à dire', () => {
    expect(decideOptOut(undefined, undefined, undefined)).toEqual({
      refused: false,
    });
  });

  it('honore un cookie posé lors d’une visite précédente', () => {
    // L'absence de signal n'est pas une révocation : le cookie *est* la trace
    // d'une opposition antérieure, et rien d'autre ne la porte.
    expect(decideOptOut(entete('1'), undefined, undefined)).toEqual({
      refused: true,
    });
  });

  it('n’écrit rien en honorant un cookie déjà là', () => {
    // Le rafraîchir serait légitime, mais annoncer un `Set-Cookie` à chaque
    // événement pour ne rien changer est du bruit sur la réponse.
    expect(
      decideOptOut(entete('1'), undefined, undefined).setCookie,
    ).toBeUndefined();
  });
});

describe('decideOptOut — Sec-GPC', () => {
  it('écarte sur `1`, et sans rien écrire', () => {
    const decision = decideOptOut(undefined, '1', undefined);

    expect(decision.refused).toBe(true);
    // Rien à mémoriser : le navigateur renverra l'en-tête à chaque requête.
    // Poser un cookie pour retenir ce qu'on nous redira serait écrire sans
    // raison, donc sortir de ce que l'exemption couvre.
    expect(decision.setCookie).toBeUndefined();
  });

  it('ignore toute autre valeur que `1`', () => {
    // La spécification n'en définit pas d'autre. Traiter la présence comme un
    // refus écarterait du trafic sur un en-tête mal formé.
    for (const valeur of ['0', '', 'true', 'yes']) {
      expect(decideOptOut(undefined, valeur, undefined).refused).toBe(false);
    }
  });

  it('tolère les espaces autour de la valeur', () => {
    expect(decideOptOut(undefined, ' 1 ', undefined).refused).toBe(true);
  });
});

describe('decideOptOut — signal explicite', () => {
  it('pose le cookie et écarte l’événement qui porte l’opposition', () => {
    const decision = decideOptOut(undefined, undefined, true);

    expect(decision.refused).toBe(true);
    expect(decision.setCookie).toContain('__Host-eh_optout=1');
    expect(decision.setCookie).toContain('Partitioned');
    expect(decision.setCookie).toContain(`Max-Age=${395 * 24 * 60 * 60}`);
  });

  it('ne porte aucun identifiant', () => {
    // Un opt-out qui distinguerait les gens serait le traceur qu'on éteint.
    const { setCookie } = decideOptOut(undefined, undefined, true);

    expect(setCookie).toMatch(/^__Host-eh_optout=1;/);
  });

  it('efface le cookie au retrait de l’opposition', () => {
    const decision = decideOptOut(entete('1'), undefined, false);

    expect(decision.setCookie).toContain('Max-Age=0');
    // Écarté quand même : cet événement-ci ne mesure rien, il porte une
    // décision. L'écrire inscrirait son type au vocabulaire du projet.
    expect(decision.refused).toBe(true);
  });

  it('n’annonce rien à qui retire une opposition qu’il n’avait pas', () => {
    const decision = decideOptOut(undefined, undefined, false);

    expect(decision.setCookie).toBeUndefined();
    expect(decision.refused).toBe(true);
  });

  it('laisse repartir la mesure dès l’événement suivant', () => {
    // Le porteur est jeté, mais le cookie n'est plus là : celui d'après passe.
    decideOptOut(entete('1'), undefined, false);

    expect(decideOptOut(undefined, undefined, undefined).refused).toBe(false);
  });
});

describe('decideOptOut — lecture du cookie', () => {
  it('ne confond pas un nom dont le sien est un suffixe', () => {
    expect(
      decideOptOut('x__Host-eh_optout=1', undefined, undefined).refused,
    ).toBe(false);
  });

  it('écarte quelle que soit la valeur posée', () => {
    // Seule la présence compte. Un visiteur qui bricole la valeur pour se faire
    // écarter obtient exactement ce qu'il demandait.
    expect(decideOptOut(entete('nimporte'), undefined, undefined).refused).toBe(
      true,
    );
  });
});

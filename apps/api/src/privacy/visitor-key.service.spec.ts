import { ConfigService } from '@nestjs/config';

import { VisitorKeyService } from './visitor-key.service';

const identity = {
  projectId: '2e95b1b6-2a96-443a-919f-2b3661106689',
  ip: '203.0.113.42',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
};

const JOUR_J = new Date('2026-08-21T09:00:00.000Z');
const JOUR_J_PLUS_TARD = new Date('2026-08-21T23:59:59.999Z');
const JOUR_SUIVANT = new Date('2026-08-22T00:00:00.000Z');

/** `ConfigService` réduit à ce que le service consomme : un secret. */
function serviceAvecSecret(secret: string): VisitorKeyService {
  return new VisitorKeyService({
    getOrThrow: () => secret,
  } as unknown as ConfigService);
}

describe('VisitorKeyService', () => {
  const service = serviceAvecSecret('secret-de-test');

  it('rend la même clé pour le même visiteur dans la même journée', () => {
    expect(service.compute(identity, JOUR_J)).toBe(
      service.compute(identity, JOUR_J_PLUS_TARD),
    );
  });

  it('rend une clé différente le jour suivant', () => {
    expect(service.compute(identity, JOUR_SUIVANT)).not.toBe(
      service.compute(identity, JOUR_J),
    );
  });

  it('cloisonne par projet : deux sites ne peuvent pas recouper leurs audiences', () => {
    const autreProjet = {
      ...identity,
      projectId: '00000000-0000-4000-8000-000000000000',
    };

    expect(service.compute(autreProjet, JOUR_J)).not.toBe(
      service.compute(identity, JOUR_J),
    );
  });

  it('distingue deux IP, et deux User-Agents', () => {
    const autreIp = { ...identity, ip: '198.51.100.7' };
    const autreUa = { ...identity, userAgent: 'curl/8.7.1' };

    expect(service.compute(autreIp, JOUR_J)).not.toBe(
      service.compute(identity, JOUR_J),
    );
    expect(service.compute(autreUa, JOUR_J)).not.toBe(
      service.compute(identity, JOUR_J),
    );
  });

  it('ne confond pas deux découpages différents des mêmes octets', () => {
    // Sans séparateur, `("ab", "c")` et `("a", "bc")` produiraient la même
    // entrée de hachage — donc la même clé pour deux visiteurs distincts.
    const a = { ...identity, ip: '1.2.3.4', userAgent: '5' };
    const b = { ...identity, ip: '1.2.3.', userAgent: '45' };

    expect(service.compute(a, JOUR_J)).not.toBe(service.compute(b, JOUR_J));
  });

  it('rend une empreinte SHA-256, pas la donnée source', () => {
    const key = service.compute(identity, JOUR_J);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(identity.ip);
    expect(key).not.toContain(identity.userAgent);
  });

  it('produit des clés incompatibles si le secret maître change', () => {
    // Ce qui protège la donnée n'est pas le hachage seul mais le secret : sans
    // lui, la clé n'est pas recalculable.
    expect(
      serviceAvecSecret('autre-secret').compute(identity, JOUR_J),
    ).not.toBe(service.compute(identity, JOUR_J));
  });
});

describe('VisitorKeyService — le mode durable', () => {
  const service = serviceAvecSecret('secret-de-test');
  const VISITOR_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const cle = () => service.computeStable(identity.projectId, VISITOR_ID);

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ne dépend d’aucune date', () => {
    // La méthode ne prend pas d'instant, donc rien ne l'empêcherait d'aller
    // lire l'horloge. Ce test-là est le seul qui casserait si quelqu'un y
    // glissait un jour le secret du jour — et il casserait sur la propriété
    // qui définit ce mode, pas sur son implémentation.
    jest.useFakeTimers().setSystemTime(JOUR_J);
    const aujourdhui = cle();

    jest.setSystemTime(new Date('2027-05-04T00:00:00.000Z'));

    expect(cle()).toBe(aujourdhui);
  });

  it('cloisonne par projet, comme le mode dérivé', () => {
    // Sans ça, le mode consenti serait *moins* cloisonné que celui qui ne
    // demande rien : deux projets servis à la même personne partageraient une
    // valeur identique en base.
    expect(
      service.computeStable('00000000-0000-4000-8000-000000000000', VISITOR_ID),
    ).not.toBe(cle());
  });

  it('distingue deux visiteurs du même projet', () => {
    expect(
      service.computeStable(
        identity.projectId,
        '9f8b7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c',
      ),
    ).not.toBe(cle());
  });

  it('vit dans un espace disjoint de celui des clés dérivées', () => {
    // Les deux modes emploient des secrets différents — le maître ici, celui du
    // jour là-bas. Une collision entre eux confondrait deux visiteurs.
    expect(cle()).not.toBe(service.compute(identity, JOUR_J));
  });

  it('rend une empreinte, jamais l’identifiant présenté', () => {
    // Ce qui atteint la base ne permet ni de reconnaître le cookie d'un
    // visiteur, ni d'en fabriquer un.
    expect(cle()).toMatch(/^[0-9a-f]{64}$/);
    expect(cle()).not.toContain(VISITOR_ID);
  });

  it('produit des clés incompatibles si le secret maître change', () => {
    expect(
      serviceAvecSecret('autre-secret').computeStable(
        identity.projectId,
        VISITOR_ID,
      ),
    ).not.toBe(cle());
  });
});

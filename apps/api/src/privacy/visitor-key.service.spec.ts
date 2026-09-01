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

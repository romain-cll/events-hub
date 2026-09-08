// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { mirrorVisitorId } from './visitor-mirror.ts';

/**
 * Sous rendu serveur, déposer une copie n'a aucun sens et ne doit rien casser.
 *
 * Un composant partagé construit `Analytics` au montage, et ce code tourne aussi
 * au rendu serveur. Toucher `document` y lèverait, donc casserait la page hôte
 * pour une écriture qui n'avait de toute façon nulle part où aller.
 */
describe('mirrorVisitorId hors navigateur', () => {
  it('ne lève pas, et n’écrit nulle part', () => {
    expect(typeof document).toBe('undefined');
    expect(() => {
      mirrorVisitorId('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    }).not.toThrow();
    expect(() => {
      mirrorVisitorId(undefined);
    }).not.toThrow();
  });
});

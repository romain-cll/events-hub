// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { collectAttributes } from './attributes.ts';

/**
 * Le garde `window` du SDK, vérifié là où il compte : sans DOM du tout.
 *
 * C'est le cas d'un rendu serveur (TanStack Start, Next…). Un `track()` qui
 * lèverait un `ReferenceError` casserait le rendu de la page hôte.
 */
describe('collectAttributes hors navigateur', () => {
  it('rend un contexte vide au lieu de lever', () => {
    expect(collectAttributes()).toEqual({});
  });
});

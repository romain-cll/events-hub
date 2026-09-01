// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from './index.ts';

/**
 * Sous rendu serveur, `start()` doit être un non-événement.
 *
 * Un composant partagé appelle `analytics.start()` au montage ; ce code est
 * aussi exécuté au rendu serveur, où il n'y a ni `document` à écouter ni page à
 * quitter. Lever y casserait le rendu de la page hôte.
 */
describe('Analytics.start() hors navigateur', () => {
  it('ne branche rien, ne poste rien, et rend un débranchement inerte', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const analytics = new Analytics({
      apiKey: 'eh_pk_2e95b1b62a96443a919f2b3661106689',
      endpoint: 'https://hub.test/v1/events',
    });

    const stop = analytics.start();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => {
      stop();
    }).not.toThrow();

    vi.unstubAllGlobals();
  });
});

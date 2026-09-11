// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { collectCampaign } from './campaign.ts';

/**
 * Sous rendu serveur, il n'y a pas d'URL à lire et ce n'est pas une erreur.
 *
 * Un composant partagé construit `Analytics` au montage, et ce code tourne aussi
 * au rendu serveur. Lever y casserait la page hôte pour une lecture d'agrément.
 */
describe('collectCampaign hors navigateur', () => {
  it('ne lève pas, et ne rend rien', () => {
    expect(typeof window).toBe('undefined');
    expect(collectCampaign()).toBeUndefined();
  });
});

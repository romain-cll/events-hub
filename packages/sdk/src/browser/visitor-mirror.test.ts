import { afterEach, describe, expect, it, vi } from 'vitest';

import { mirrorVisitorId } from './visitor-mirror.ts';

/**
 * La copie déposée sur le domaine du site.
 *
 * Les assertions passent par un espion sur le *setter* plutôt que par
 * `document.cookie` : la lecture ne rend que les paires `nom=valeur`, jamais les
 * attributs. Or ce sont eux qui décident si la copie existe — un `SameSite`
 * erroné et le backend du site ne la voit jamais.
 */

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** 13 mois, en secondes. Réécrit ici plutôt qu'importé, exprès. */
const TREIZE_MOIS = 34_128_000;

const espionnerLeCookie = () => vi.spyOn(document, 'cookie', 'set');

describe('mirrorVisitorId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dépose l’identifiant avec les attributs qui le rendent lisible', () => {
    const cookie = espionnerLeCookie();

    mirrorVisitorId(ID);

    // `SameSite=Lax` et non `None` : cette copie ne sert qu'aux requêtes du site
    // vers son propre backend.
    expect(cookie).toHaveBeenCalledWith(
      `eh_visitor_id=${ID}; Path=/; SameSite=Lax; Secure; Max-Age=${TREIZE_MOIS}`,
    );
  });

  it('efface la copie quand il n’y a plus d’identifiant', () => {
    const cookie = espionnerLeCookie();

    mirrorVisitorId(undefined);

    // Le cas qui compte vraiment : sans cet effacement, une copie posée avant un
    // retrait de consentement survivrait 13 mois et continuerait de partir
    // dans les paiements du site.
    expect(cookie).toHaveBeenCalledWith(
      'eh_visitor_id=; Path=/; SameSite=Lax; Secure; Max-Age=0',
    );
  });

  it('n’exige pas HTTPS d’un site servi en clair', () => {
    // Un `Secure` posé sur une origine non sûre est refusé sans un mot : le
    // développement local d'un site en HTTP verrait la copie disparaître sans
    // rien pour l'expliquer.
    vi.stubGlobal('location', { protocol: 'http:' });
    const cookie = espionnerLeCookie();

    mirrorVisitorId(ID);

    expect(cookie).toHaveBeenCalledWith(expect.not.stringContaining('Secure'));
  });

  it('est bien relue par le navigateur, puis bien effacée', () => {
    // Le pendant de l'espion : ce que jsdom accepte réellement de stocker.
    mirrorVisitorId(ID);
    expect(document.cookie).toContain(`eh_visitor_id=${ID}`);

    mirrorVisitorId(undefined);
    expect(document.cookie).not.toContain('eh_visitor_id=');
  });
});

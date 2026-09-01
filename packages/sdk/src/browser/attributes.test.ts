import { afterEach, describe, expect, it } from 'vitest';

import { setReferrer } from '../test-helpers.ts';
import { SDK_VERSION } from '../version.ts';
import { collectAttributes } from './attributes.ts';

describe('collectAttributes', () => {
  afterEach(() => {
    setReferrer('');
    window.history.replaceState(null, '', '/');
  });

  it('lit le contexte navigateur', () => {
    window.history.replaceState(null, '', '/pricing?plan=pro#faq');

    expect(collectAttributes()).toMatchObject({
      'page.path': '/pricing',
      'page.url': 'https://site.test/pricing?plan=pro#faq',
      'browser.language': navigator.language,
      'screen.width': window.screen.width,
      'screen.height': window.screen.height,
    });
  });

  it('annonce la version du SDK', () => {
    // Le seul attribut qui décrive l'émetteur et pas le navigateur. Il existe
    // pour qu'une version qui envoie du mauvais soit identifiable après coup —
    // c'est la seule chose que la suppression de la colonne `version` a laissée
    // sans réponse, et elle vit ici parce qu'elle vient du client.
    expect(collectAttributes()['sdk.version']).toBe(SDK_VERSION);
  });

  it('omet page.referrer sur une entrée directe', () => {
    setReferrer('');

    expect(collectAttributes()).not.toHaveProperty('page.referrer');
  });

  it('transmet page.referrer quand il existe', () => {
    setReferrer('https://recherche.test/?q=analytics');

    expect(collectAttributes()['page.referrer']).toBe(
      'https://recherche.test/?q=analytics',
    );
  });

  it('relit la page à chaque appel', () => {
    window.history.replaceState(null, '', '/a');
    const first = collectAttributes();
    window.history.replaceState(null, '', '/b');

    expect(first['page.path']).toBe('/a');
    expect(collectAttributes()['page.path']).toBe('/b');
  });
});

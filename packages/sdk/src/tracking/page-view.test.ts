import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRecorder,
  goBack,
  resetPage,
  setReferrer,
} from '../test-helpers.ts';
import type { Teardown } from '../types.ts';
import { trackPageViews } from './page-view.ts';

describe('page_view', () => {
  let recorder: ReturnType<typeof createRecorder>;
  let stop: Teardown;

  beforeEach(() => {
    resetPage();
    recorder = createRecorder();
    stop = trackPageViews(recorder.emit);
  });

  afterEach(() => {
    stop();
  });

  it('émet au chargement initial', () => {
    expect(recorder.events).toEqual([
      {
        type: 'page_view',
        properties: { 'navigation.type': 'initial' },
        options: {},
      },
    ]);
  });

  it('émet sur pushState vers une nouvelle URL', () => {
    window.history.pushState(null, '', '/pricing');

    expect(recorder.types()).toEqual(['page_view', 'page_view']);
    expect(recorder.last()?.properties).toEqual({
      'navigation.type': 'push_state',
      'navigation.from': '/',
    });
  });

  it("n'émet pas sur pushState vers la même URL", () => {
    window.history.pushState(null, '', '/');
    window.history.pushState({ step: 2 }, '', '/');

    expect(recorder.types()).toEqual(['page_view']);
  });

  it('émet sur replaceState vers une nouvelle URL', () => {
    window.history.replaceState(null, '', '/pricing');

    expect(recorder.last()).toMatchObject({
      type: 'page_view',
      properties: { 'navigation.type': 'replace_state' },
    });
  });

  it('émet sur popstate vers une nouvelle URL', async () => {
    window.history.pushState(null, '', '/pricing');
    window.history.pushState(null, '', '/contact');
    await goBack();

    expect(recorder.types()).toEqual([
      'page_view',
      'page_view',
      'page_view',
      'page_view',
    ]);
    expect(recorder.last()).toMatchObject({
      type: 'page_view',
      properties: {
        'navigation.type': 'pop_state',
        'navigation.from': '/contact',
      },
    });
  });

  it('distingue deux URLs par leur query string', () => {
    window.history.pushState(null, '', '/list?page=2');
    window.history.pushState(null, '', '/list?page=3');

    expect(recorder.types()).toHaveLength(3);
  });

  it('ignore le hash', () => {
    window.history.pushState(null, '', '/#faq');

    expect(recorder.types()).toEqual(['page_view']);
  });

  it("restaure l'History API au débranchement", () => {
    stop();
    window.history.pushState(null, '', '/apres');

    // L'History API marche toujours, mais n'est plus instrumentée.
    expect(window.location.pathname).toBe('/apres');
    expect(recorder.types()).toEqual(['page_view']);
  });
});

/**
 * `navigation.from` veut dire la même chose en SPA et en MPA : la page
 * précédente du même site, ou rien.
 *
 * Le referrer doit être posé *avant* le démarrage du collecteur — il décrit le
 * chargement du document, pas un état qu'on modifie en cours de route. D'où un
 * bloc séparé, qui ne démarre pas dans `beforeEach`.
 */
describe('page_view — navigation.from', () => {
  let recorder: ReturnType<typeof createRecorder>;
  let stop: Teardown | undefined;

  const arriverSur = (path: string, referrer: string) => {
    resetPage();
    setReferrer(referrer);
    window.history.replaceState(null, '', path);
    recorder = createRecorder();
    stop = trackPageViews(recorder.emit);
  };

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('MPA interne : /pricing -> /checkout donne /pricing', () => {
    arriverSur('/checkout', 'https://site.test/pricing');

    expect(recorder.last()?.properties).toEqual({
      'navigation.type': 'initial',
      'navigation.from': '/pricing',
    });
  });

  it('MPA interne : la query de la page précédente est conservée', () => {
    arriverSur('/checkout', 'https://site.test/list?page=2');

    expect(recorder.last()?.properties['navigation.from']).toBe('/list?page=2');
  });

  it('MPA interne : le hash de la page précédente est écarté, comme dans pageKey', () => {
    arriverSur('/checkout', 'https://site.test/pricing#faq');

    expect(recorder.last()?.properties['navigation.from']).toBe('/pricing');
  });

  it('SPA : /pricing -> /checkout donne /pricing', () => {
    arriverSur('/pricing', '');
    window.history.pushState(null, '', '/checkout');

    expect(recorder.last()?.properties).toEqual({
      'navigation.type': 'push_state',
      'navigation.from': '/pricing',
    });
  });

  it('entrée externe : un referrer d’une autre origine ne donne rien', () => {
    arriverSur('/pricing', 'https://www.google.com/search?q=analytics');

    expect(recorder.last()?.properties).toEqual({
      'navigation.type': 'initial',
    });
  });

  it('entrée externe : un sous-domaine compte comme externe', () => {
    arriverSur('/pricing', 'https://blog.site.test/article');

    expect(recorder.last()?.properties).not.toHaveProperty('navigation.from');
  });

  it('entrée directe : pas de referrer, pas de page précédente', () => {
    arriverSur('/pricing', '');

    expect(recorder.last()?.properties).toEqual({
      'navigation.type': 'initial',
    });
  });

  it('navigation interne vers un fragment : /pricing -> /pricing#foo ne donne rien', () => {
    // Même clé de page des deux côtés : le hash ne fait pas partie de
    // l'identité d'une page. Se déclarer sa propre page précédente ne décrirait
    // aucun parcours.
    arriverSur('/pricing', 'https://site.test/pricing');

    expect(recorder.last()?.properties).not.toHaveProperty('navigation.from');
  });

  it('rechargement : la page ne se déclare pas sa propre page précédente', () => {
    arriverSur('/pricing', 'https://site.test/pricing');

    expect(recorder.last()?.properties).not.toHaveProperty('navigation.from');
  });

  it("le referrer ne sert qu'à la première vue", () => {
    // Entrée externe puis navigation SPA : la deuxième vue vient de la première
    // page du site, pas de Google. Sans ce comportement, une entrée externe
    // contaminerait tout le parcours qui suit.
    arriverSur('/pricing', 'https://www.google.com/search?q=analytics');
    window.history.pushState(null, '', '/checkout');

    expect(recorder.last()?.properties['navigation.from']).toBe('/pricing');
  });

  it('un referrer non résolvable ne fait pas tomber la collecte', () => {
    arriverSur('/pricing', 'pas une URL');

    expect(recorder.types()).toEqual(['page_view']);
    expect(recorder.last()?.properties).not.toHaveProperty('navigation.from');
  });
});

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import {
  createRecorder,
  preventNavigation,
  resetPage,
} from '../test-helpers.ts';
import type { Teardown } from '../types.ts';
import { trackOutboundClicks } from './outbound-click.ts';

function renderLink(html: string): HTMLAnchorElement {
  document.body.innerHTML = html;

  return document.querySelector('a')!;
}

/** Un clic tel que le navigateur le produit, modificateurs compris. */
function click(element: Element, init: MouseEventInit = {}): void {
  element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, ...init }),
  );
}

describe('outbound_click', () => {
  let recorder: ReturnType<typeof createRecorder>;
  let onLeaving: Mock<() => void>;
  let stop: Teardown;
  let restoreNavigation: () => void;

  beforeEach(() => {
    resetPage();
    recorder = createRecorder();
    onLeaving = vi.fn<() => void>();
    stop = trackOutboundClicks(recorder.emit, onLeaving);
    restoreNavigation = preventNavigation();
  });

  afterEach(() => {
    restoreNavigation();
    stop();
  });

  it('émet sur un lien vers une autre origine, et signale le départ', () => {
    click(renderLink('<a id="doc" href="https://autre.test/docs">Doc</a>'));

    expect(recorder.last()).toMatchObject({
      type: 'outbound_click',
      properties: {
        'element.tag': 'a',
        'element.id': 'doc',
        'element.href': 'https://autre.test/docs',
        'link.origin': 'https://autre.test',
      },
    });
    expect(onLeaving).toHaveBeenCalledOnce();
  });

  it("n'émet pas sur un lien interne", () => {
    click(renderLink('<a href="/pricing">Tarifs</a>'));

    expect(recorder.events).toEqual([]);
    expect(onLeaving).not.toHaveBeenCalled();
  });

  it("n'émet pas sur une URL absolue de la même origine", () => {
    click(renderLink('<a href="https://site.test/a">Interne</a>'));

    expect(recorder.events).toEqual([]);
  });

  it('émet sur le même hôte servi depuis un autre port', () => {
    click(renderLink('<a href="https://site.test:8443/a">Autre port</a>'));

    expect(recorder.last()?.properties).toMatchObject({
      'link.origin': 'https://site.test:8443',
    });
  });

  it("n'émet pas sur mailto: ni tel:", () => {
    click(renderLink('<a href="mailto:contact@autre.test">Mail</a>'));
    click(renderLink('<a href="tel:+33100000000">Tel</a>'));

    expect(recorder.events).toEqual([]);
  });

  it("n'émet pas sur un href vide ou non résolvable", () => {
    click(renderLink('<a>Ancre sans href</a>'));

    expect(recorder.events).toEqual([]);
  });

  it("remonte au lien quand le clic vient d'un enfant", () => {
    renderLink('<a href="https://autre.test/"><span id="s">Aller</span></a>');
    click(document.querySelector('#s')!);

    expect(recorder.last()?.type).toBe('outbound_click');
  });

  it('signale le clic mais pas le départ sur Cmd/Ctrl-clic', () => {
    const link = renderLink('<a href="https://autre.test/">Doc</a>');
    click(link, { metaKey: true });
    click(link, { ctrlKey: true });

    expect(recorder.types()).toEqual(['outbound_click', 'outbound_click']);
    expect(onLeaving).not.toHaveBeenCalled();
  });

  it('signale le clic mais pas le départ sur target="_blank"', () => {
    click(renderLink('<a href="https://autre.test/" target="_blank">Doc</a>'));

    expect(recorder.types()).toEqual(['outbound_click']);
    expect(onLeaving).not.toHaveBeenCalled();
  });

  it('signale le clic mais pas le départ sur un lien download', () => {
    click(renderLink('<a href="https://autre.test/f.pdf" download>PDF</a>'));

    expect(recorder.types()).toEqual(['outbound_click']);
    expect(onLeaving).not.toHaveBeenCalled();
  });

  it("signale le clic mais pas le départ si le site a annulé l'action", () => {
    const link = renderLink('<a href="https://autre.test/">Doc</a>');
    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    click(link);

    expect(recorder.types()).toEqual(['outbound_click']);
    expect(onLeaving).not.toHaveBeenCalled();
  });

  it('signale le départ sur target="_self"', () => {
    click(renderLink('<a href="https://autre.test/" target="_self">Doc</a>'));

    expect(onLeaving).toHaveBeenCalledOnce();
  });

  it("n'émet plus après débranchement", () => {
    const link = renderLink('<a href="https://autre.test/">Doc</a>');
    stop();
    click(link);

    expect(recorder.events).toEqual([]);
  });
});

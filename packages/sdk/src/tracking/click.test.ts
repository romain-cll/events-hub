import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRecorder,
  preventNavigation,
  resetPage,
} from '../test-helpers.ts';
import type { Teardown } from '../types.ts';
import { trackClicks } from './click.ts';

/** Pose du HTML et rend le premier élément marqué `id="cible"`. */
function render(html: string): HTMLElement {
  document.body.innerHTML = html;

  return document.querySelector<HTMLElement>('#cible')!;
}

describe('click', () => {
  let recorder: ReturnType<typeof createRecorder>;
  let stop: Teardown;
  let restoreNavigation: () => void;

  beforeEach(() => {
    resetPage();
    recorder = createRecorder();
    stop = trackClicks(recorder.emit);
    restoreNavigation = preventNavigation();
  });

  afterEach(() => {
    restoreNavigation();
    stop();
  });

  it('capture un bouton', () => {
    render(
      '<button id="cible" name="valider" type="submit">OK</button>',
    ).click();

    expect(recorder.last()).toMatchObject({
      type: 'click',
      properties: {
        'element.tag': 'button',
        'element.id': 'cible',
        'element.name': 'valider',
        'element.type': 'submit',
      },
    });
  });

  it('capture un lien, href résolu en absolu', () => {
    render('<a id="cible" href="/pricing">Tarifs</a>').click();

    expect(recorder.last()).toMatchObject({
      type: 'click',
      properties: {
        'element.tag': 'a',
        'element.href': 'https://site.test/pricing',
      },
    });
  });

  it('capture un [role="button"]', () => {
    render('<div id="cible" role="button">Ouvrir</div>').click();

    expect(recorder.last()).toMatchObject({
      type: 'click',
      properties: { 'element.tag': 'div', 'element.role': 'button' },
    });
  });

  it('capture aussi les champs de formulaire', () => {
    render('<select id="cible" name="pays"></select>').click();

    expect(recorder.last()).toMatchObject({
      properties: { 'element.tag': 'select', 'element.name': 'pays' },
    });
  });

  it('ignore un div quelconque', () => {
    render('<div id="cible">Texte</div>').click();

    expect(recorder.events).toEqual([]);
  });

  it("remonte au bouton quand le clic vient d'un enfant", () => {
    render('<button id="cible"><span id="icone">i</span> Envoyer</button>');
    document.querySelector<HTMLElement>('#icone')!.click();

    expect(recorder.last()).toMatchObject({
      properties: { 'element.tag': 'button', 'element.id': 'cible' },
    });
  });

  it('ne capture jamais le texte du DOM', () => {
    render(
      '<button id="cible" name="suppression">Supprimer le compte de Marie</button>',
    ).click();

    expect(JSON.stringify(recorder.last()?.properties)).not.toContain('Marie');
  });

  it("ne capture jamais la valeur d'un champ", () => {
    const input = render(
      '<input id="cible" name="email" type="email" />',
    ) as HTMLInputElement;
    input.value = 'marie@exemple.test';
    input.click();

    expect(recorder.last()).toMatchObject({
      properties: { 'element.tag': 'input', 'element.name': 'email' },
    });
    expect(JSON.stringify(recorder.last()?.properties)).not.toContain(
      'exemple.test',
    );
  });

  it('omet les clés sans information', () => {
    render('<button id="cible">OK</button>').click();

    expect(Object.keys(recorder.last()!.properties)).toEqual([
      'element.tag',
      'element.id',
    ]);
  });

  it("n'émet plus après débranchement", () => {
    const button = render('<button id="cible">OK</button>');
    stop();
    button.click();

    expect(recorder.events).toEqual([]);
  });
});

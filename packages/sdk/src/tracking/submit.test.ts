import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRecorder,
  preventNavigation,
  resetPage,
} from '../test-helpers.ts';
import type { Teardown } from '../types.ts';
import { trackSubmits } from './submit.ts';

function renderForm(html: string): HTMLFormElement {
  document.body.innerHTML = html;

  return document.querySelector('form')!;
}

/**
 * jsdom n'exécute pas la soumission native, et `form.submit()` ne déclenche
 * volontairement aucun événement `submit` (c'est la spec). On dispatche donc
 * l'événement tel que le navigateur le produit : bulle et annulable.
 */
function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('submit', () => {
  let recorder: ReturnType<typeof createRecorder>;
  let stop: Teardown;
  let restoreNavigation: () => void;

  beforeEach(() => {
    resetPage();
    recorder = createRecorder();
    stop = trackSubmits(recorder.emit);
    restoreNavigation = preventNavigation();
  });

  afterEach(() => {
    restoreNavigation();
    stop();
  });

  it('capture la soumission', () => {
    submit(
      renderForm(
        '<form id="inscription" name="signup" action="/api/signup" method="post"></form>',
      ),
    );

    expect(recorder.last()).toMatchObject({
      type: 'submit',
      properties: {
        'form.id': 'inscription',
        'form.name': 'signup',
        'form.action': 'https://site.test/api/signup',
        'form.method': 'post',
      },
    });
  });

  it("omet form.action quand l'attribut n'est pas écrit", () => {
    submit(renderForm('<form id="recherche"></form>'));

    expect(recorder.last()?.properties).toEqual({
      'form.id': 'recherche',
      'form.method': 'get',
    });
  });

  it('ne capture jamais la valeur des champs', () => {
    const form = renderForm(
      '<form id="connexion"><input name="email" /><input name="password" type="password" /></form>',
    );
    form.querySelectorAll('input')[0].value = 'marie@exemple.test';
    form.querySelectorAll('input')[1].value = 'hunter2';
    submit(form);

    const serialized = JSON.stringify(recorder.last()?.properties);
    expect(serialized).not.toContain('exemple.test');
    expect(serialized).not.toContain('hunter2');
  });

  it('ne capture pas non plus le nom des champs', () => {
    submit(renderForm('<form id="c"><input name="numero_carte" /></form>'));

    expect(JSON.stringify(recorder.last()?.properties)).not.toContain(
      'numero_carte',
    );
  });

  it("n'émet plus après débranchement", () => {
    const form = renderForm('<form id="x"></form>');
    stop();
    submit(form);

    expect(recorder.events).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRecorder, resetPage, setVisibility } from '../test-helpers.ts';
import {
  trackPageLeave,
  type LeaveReason,
  type PageLeaveTracker,
} from './page-leave.ts';

describe('page_leave', () => {
  let recorder: ReturnType<typeof createRecorder>;
  let tracker: PageLeaveTracker;

  beforeEach(() => {
    resetPage();
    setVisibility('visible');
    recorder = createRecorder();
    tracker = trackPageLeave(recorder.emit);
  });

  afterEach(() => {
    tracker.stop();
  });

  it('émet sur pagehide', () => {
    window.dispatchEvent(new Event('pagehide'));

    expect(recorder.events).toEqual([
      {
        type: 'page_leave',
        properties: { 'leave.reason': 'pagehide' },
        options: { beacon: true },
      },
    ]);
  });

  it('émet quand le document passe en hidden', () => {
    setVisibility('hidden');

    expect(recorder.last()).toMatchObject({
      type: 'page_leave',
      properties: { 'leave.reason': 'page_hidden' },
    });
  });

  it("n'émet pas quand le document redevient visible", () => {
    setVisibility('visible');

    expect(recorder.events).toEqual([]);
  });

  it('émet sur clic sortant', () => {
    tracker.leave('outbound_click');

    expect(recorder.last()).toMatchObject({
      type: 'page_leave',
      properties: { 'leave.reason': 'outbound_click' },
    });
  });

  it('part toujours par beacon, jamais par un fetch qui mourrait avec la page', () => {
    setVisibility('hidden');

    expect(recorder.last()?.options).toEqual({ beacon: true });
  });

  it("ne compte qu'un seul départ pour un clic sortant suivi de pagehide", () => {
    tracker.leave('outbound_click');
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));

    expect(recorder.types()).toEqual(['page_leave']);
    expect(recorder.last()?.properties).toEqual({
      'leave.reason': 'outbound_click',
    });
  });

  it("ne compte qu'un seul départ pour visibilitychange suivi de pagehide", () => {
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));

    expect(recorder.types()).toEqual(['page_leave']);
  });

  it('recompte une perte de présence après un retour sur la page', () => {
    setVisibility('hidden');
    setVisibility('visible');
    window.dispatchEvent(new Event('pagehide'));

    expect(recorder.types()).toEqual(['page_leave', 'page_leave']);
    expect(recorder.events.map((event) => event.properties)).toEqual([
      { 'leave.reason': 'page_hidden' },
      { 'leave.reason': 'pagehide' },
    ]);
  });

  // Le drapeau déduplique *une* perte, pas la durée de vie de la page : un
  // visiteur qui fait des allers-retours entre onglets toute la journée doit
  // produire une perte par retour en arrière-plan, sinon on ne verrait que la
  // première et le temps actif serait indécomptable.
  it('émet une fois par nouvelle perte de visibilité, pas une fois pour toutes', () => {
    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');

    expect(recorder.types()).toEqual([
      'page_leave',
      'page_leave',
      'page_leave',
    ]);
    expect(
      recorder.events.every(
        (event) => event.properties['leave.reason'] === 'page_hidden',
      ),
    ).toBe(true);
  });

  it("n'émet rien de plus tant que la page reste cachée", () => {
    setVisibility('hidden');
    setVisibility('hidden');

    expect(recorder.types()).toEqual(['page_leave']);
  });

  // `leave.reason` décrit *cet* événement-là, il n'est pas du contexte
  // navigateur : sa place est dans `properties`, que le collecteur remplit.
  // `attributes` est assemblé par le client et n'est même pas atteignable
  // d'ici — ce test verrouille la frontière côté collecteur, `index.test.ts`
  // la vérifie sur l'enveloppe réellement postée.
  it('porte la raison dans properties, et rien à côté', () => {
    setVisibility('hidden');

    const event = recorder.last();
    expect(Object.keys(event?.properties ?? {})).toEqual(['leave.reason']);
    expect(event).not.toHaveProperty('attributes');
  });

  it("s'en tient à l'enum fermé des raisons", () => {
    const reasons: LeaveReason[] = ['page_hidden', 'pagehide', 'outbound_click'];

    for (const reason of reasons) {
      const solo = createRecorder();
      const isolated = trackPageLeave(solo.emit);
      isolated.leave(reason);
      isolated.stop();

      expect(solo.last()?.properties).toEqual({ 'leave.reason': reason });
    }
  });

  it("n'émet plus après débranchement", () => {
    tracker.stop();
    window.dispatchEvent(new Event('pagehide'));

    expect(recorder.events).toEqual([]);
  });
});

import { vi } from 'vitest';

import type { Emit, EmitOptions, EventProperties } from './types.ts';

export interface RecordedEvent {
  type: string;
  properties: EventProperties;
  options: EmitOptions;
}

/**
 * Un `Emit` qui garde tout ce qu'on lui passe.
 *
 * Les collecteurs sont testés contre lui plutôt qu'à travers le réseau : ce
 * qu'on vérifie ici, c'est la traduction « signal du navigateur -> événement »,
 * pas le transport. `index.test.ts` s'occupe du reste.
 */
export function createRecorder() {
  const events: RecordedEvent[] = [];

  const emit: Emit = (type, properties = {}, options = {}) => {
    events.push({ type, properties, options });
  };

  return {
    emit,
    events,
    types: () => events.map((event) => event.type),
    last: () => events.at(-1),
  };
}

/**
 * Recule d'un cran dans l'historique et attend que `popstate` soit parti.
 *
 * `history.back()` ne déclenche rien de synchrone : la traversée d'historique
 * est une tâche différée, dans jsdom comme dans un vrai navigateur. Attendre
 * l'événement lui-même plutôt qu'un nombre de tours de boucle évite un test qui
 * passe ou échoue selon la machine.
 *
 * L'écouteur est posé après ceux des collecteurs, donc appelé après eux : au
 * moment où la promesse se résout, l'événement a déjà été traité.
 */
export function goBack(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true });
    window.history.back();
  });
}

/**
 * Empêche jsdom d'essayer de naviguer pour de vrai.
 *
 * Un `<a>` cliqué ou un formulaire soumis font lever à jsdom un « Not
 * implemented: navigation » qui pollue la sortie. On annule donc l'action par
 * défaut — mais **après** avoir branché les collecteurs, jamais avant : notre
 * code lit `event.defaultPrevented` pour décider si la page part vraiment, et
 * un écouteur enregistré plus tôt lui ferait croire que le site a pris la main.
 */
export function preventNavigation(): () => void {
  const cancel = (event: Event) => {
    event.preventDefault();
  };

  document.addEventListener('click', cancel);
  document.addEventListener('submit', cancel);

  return () => {
    document.removeEventListener('click', cancel);
    document.removeEventListener('submit', cancel);
  };
}

/** Force `document.visibilityState` et notifie, comme le ferait le navigateur. */
export function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * Installe un `navigator.sendBeacon` espionné.
 *
 * jsdom ne l'implémente pas : sans ce stub, `beaconEvent` tomberait toujours
 * dans son repli `fetch`, et le chemin réellement emprunté en production ne
 * serait jamais testé.
 */
export function stubSendBeacon() {
  const sendBeacon = vi.fn(() => true);

  Object.defineProperty(navigator, 'sendBeacon', {
    value: sendBeacon,
    configurable: true,
    writable: true,
  });

  return sendBeacon;
}

/**
 * Force `document.referrer`, qui est en lecture seule.
 *
 * C'est le navigateur qui le pose au chargement du document ; le redéfinir est
 * le seul moyen de rejouer une arrivée depuis une autre page.
 */
export function setReferrer(referrer: string): void {
  Object.defineProperty(document, 'referrer', {
    value: referrer,
    configurable: true,
  });
}

/** Remet le DOM, l'URL et le referrer à zéro entre deux tests. */
export function resetPage(): void {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  setReferrer('');
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  goBack,
  preventNavigation,
  resetPage,
  setVisibility,
  stubSendBeacon,
} from './test-helpers.ts';
import type { EventEnvelope } from './transport/send.ts';
import type { Teardown } from './types.ts';
import { Analytics } from './index.ts';

const API_KEY = 'eh_pk_2e95b1b62a96443a919f2b3661106689';
const ENDPOINT = 'https://hub.test/v1/events';

/**
 * Un faux hub qui journalise les envois **dans l'ordre, tous transports
 * confondus**.
 *
 * C'est le point de ce fichier : `page_leave` part par `sendBeacon` et le reste
 * par `fetch`, mais du point de vue du produit c'est un seul flux. Deux
 * journaux séparés ne diraient rien de la séquence.
 */
/** La visite que le hub rend à chaque réponse, avec ou sans consentement. */
const SESSION_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

function createHub({
  ok = true,
  visitorId,
}: { ok?: boolean; visitorId?: string } = {}) {
  // Modifiable en cours de test : c'est ce que fait un hub quand le visiteur
  // accorde puis retire son consentement.
  let identifiant = visitorId;

  const sent: {
    transport: 'fetch' | 'keepalive' | 'beacon';
    body: Promise<string>;
  }[] = [];

  // `page_leave` part par `fetch` + `keepalive`, pas par `sendBeacon` : le
  // preflight CORS d'un beacon `application/json` ne survit pas au
  // déchargement (voir `beaconEvent`). Le stub de `Request` rend ce choix
  // déterministe ici, quelle que soit la plateforme qui fait tourner les tests.
  class FakeRequest {}
  Object.defineProperty(FakeRequest.prototype, 'keepalive', { value: false });
  vi.stubGlobal('Request', FakeRequest);

  const fetchMock = vi.fn((_endpoint: string, init: RequestInit) => {
    sent.push({
      transport: init.keepalive ? 'keepalive' : 'fetch',
      body: Promise.resolve(init.body as string),
    });

    return Promise.resolve({
      ok,
      status: ok ? 201 : 422,
      statusText: ok ? 'Created' : 'Unprocessable Entity',
      json: () =>
        Promise.resolve(
          identifiant
            ? { id: 'evt_1', sessionId: SESSION_ID, visitorId: identifiant }
            : { id: 'evt_1', sessionId: SESSION_ID },
        ),
      text: () => Promise.resolve('{"message":"projet inconnu"}'),
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  const sendBeacon = stubSendBeacon();
  sendBeacon.mockImplementation(((_endpoint: string, blob: Blob) => {
    sent.push({ transport: 'beacon', body: blob.text() });

    return true;
  }) as unknown as () => boolean);

  return {
    fetchMock,
    sendBeacon,
    /** Les enveloppes reçues, dans l'ordre d'émission. */
    envelopes: async (): Promise<EventEnvelope[]> =>
      Promise.all(
        sent.map(async (call) => JSON.parse(await call.body) as EventEnvelope),
      ),
    types: async () =>
      (await Promise.all(sent.map((call) => call.body))).map(
        (body) => (JSON.parse(body) as EventEnvelope).type,
      ),
    transports: () => sent.map((call) => call.transport),
    setVisitorId: (next: string | undefined) => {
      identifiant = next;
    },
  };
}

describe('Analytics', () => {
  let hub: ReturnType<typeof createHub>;
  let analytics: Analytics;
  let stop: Teardown;
  let restoreNavigation: () => void;

  beforeEach(() => {
    resetPage();
    setVisibility('visible');
    hub = createHub();
    analytics = new Analytics({ apiKey: API_KEY, endpoint: ENDPOINT });
  });

  afterEach(() => {
    restoreNavigation?.();
    stop?.();
    vi.unstubAllGlobals();
  });

  function start(...args: Parameters<Analytics['start']>) {
    stop = analytics.start(...args);
    restoreNavigation = preventNavigation();
  }

  it("ne fait rien tant que start() n'est pas appelé", () => {
    expect(hub.fetchMock).not.toHaveBeenCalled();
  });

  it('émet un page_view complet au démarrage', async () => {
    start();

    const [event] = await hub.envelopes();
    expect(event).toMatchObject({
      apiKey: API_KEY,
      type: 'page_view',
      attributes: {
        'page.path': '/',
        'page.url': 'https://site.test/',
      },
      properties: { 'navigation.type': 'initial' },
    });
    expect(event?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  // Le test le plus important de l'étape : un routeur qui normalise l'URL au
  // montage appelle `replaceState` avec l'URL courante. Sans anti-doublon, tout
  // le trafic du site est compté deux fois — et rien ne le signale.
  it("compte exactement un page_view pour un chargement suivi d'un replaceState identique", async () => {
    start();
    window.history.replaceState(null, '', '/');

    expect(await hub.types()).toEqual(['page_view']);
  });

  it("produit la séquence complète d'une visite", async () => {
    document.body.innerHTML = `
      <button id="filtre">Filtrer</button>
      <form id="recherche" method="get"><input name="q" /></form>
      <a id="sortie" href="https://autre.test/article">Lire la suite</a>
    `;
    start();

    document.querySelector<HTMLElement>('#filtre')!.click();
    document.querySelector<HTMLElement>('#filtre')!.click();
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    window.history.pushState(null, '', '/resultats');
    document.querySelector<HTMLElement>('#sortie')!.click();

    expect(await hub.types()).toEqual([
      'page_view',
      'click',
      'click',
      'submit',
      'page_view',
      'click',
      'outbound_click',
      'page_leave',
    ]);
  });

  // Le critère de sortie de l'étape, en un test : trois pages vues sous une
  // seule présence, une perte quand l'onglet passe derrière, puis une nouvelle
  // présence qui se termine par un clic sortant.
  it("décrit une présence par perte de présence, pas une par page vue", async () => {
    document.body.innerHTML =
      '<a id="sortie" href="https://autre.test/article">Lire la suite</a>';
    start();

    window.history.pushState(null, '', '/b');
    window.history.pushState(null, '', '/c');
    setVisibility('hidden');

    setVisibility('visible');
    window.history.pushState(null, '', '/d');
    document.querySelector<HTMLElement>('#sortie')!.click();

    const envelopes = await hub.envelopes();
    expect(
      envelopes
        .filter((event) => event.type !== 'click')
        .map((event) => [event.type, event.properties['leave.reason']]),
    ).toEqual([
      ['page_view', undefined],
      ['page_view', undefined],
      ['page_view', undefined],
      ['page_leave', 'page_hidden'],
      ['page_view', undefined],
      ['outbound_click', undefined],
      ['page_leave', 'outbound_click'],
    ]);
  });

  // Naviguer dans le site n'est pas partir. Sans cette garantie, le temps actif
  // se découperait en un fragment par page et ne mesurerait plus rien.
  it("ne perd jamais la présence sur une navigation SPA", async () => {
    start();

    window.history.pushState(null, '', '/a');
    window.history.pushState(null, '', '/b');
    await goBack();

    expect(await hub.types()).toEqual([
      'page_view',
      'page_view',
      'page_view',
      'page_view',
    ]);
  });

  // La page reste sous les yeux du visiteur : le clic est un fait, la perte de
  // présence n'en est pas un. Émettre ici serait faux deux fois — on
  // inventerait une sortie, et le drapeau avalerait la vraie quand elle
  // viendrait.
  it("ne perd pas la présence sur un lien sortant qui ouvre ailleurs", async () => {
    document.body.innerHTML = `
      <a id="onglet" href="https://autre.test/a" target="_blank">Onglet</a>
      <a id="fichier" href="https://autre.test/f.pdf" download>PDF</a>
    `;
    start();

    document.querySelector<HTMLElement>('#onglet')!.click();
    document.querySelector<HTMLElement>('#fichier')!.click();

    expect(await hub.types()).toEqual([
      'page_view',
      'click',
      'outbound_click',
      'click',
      'outbound_click',
    ]);
  });

  // La frontière du contrat : `leave.reason` décrit l'événement, il n'est pas
  // du contexte navigateur. Le jour où il glisserait dans `attributes`, il
  // prétendrait valoir la même chose sur tous les événements — ce qui est faux.
  it("pose leave.reason dans properties et jamais dans attributes", async () => {
    start();
    setVisibility('hidden');

    const [, leave] = await hub.envelopes();
    expect(leave?.properties).toEqual({ 'leave.reason': 'page_hidden' });
    expect(Object.keys(leave?.attributes ?? {})).not.toContain('leave.reason');
    expect(leave?.attributes).toMatchObject({ 'page.path': '/' });
  });

  it('envoie page_leave en keepalive et le reste par fetch ordinaire', async () => {
    start();
    setVisibility('hidden');

    expect(hub.transports()).toEqual(['fetch', 'keepalive']);
    expect(hub.sendBeacon).not.toHaveBeenCalled();
    const [, leave] = await hub.envelopes();
    expect(leave).toMatchObject({
      apiKey: API_KEY,
      type: 'page_leave',
      properties: { 'leave.reason': 'page_hidden' },
    });
  });

  it('date et contextualise chaque événement à son propre instant', async () => {
    start();
    window.history.pushState(null, '', '/resultats?q=drizzle');

    const [initial, second] = await hub.envelopes();
    expect(initial?.attributes['page.url']).toBe('https://site.test/');
    expect(second?.attributes['page.url']).toBe(
      'https://site.test/resultats?q=drizzle',
    );
  });

  it('permet de désactiver un collecteur', async () => {
    document.body.innerHTML = '<button id="b">OK</button>';
    start({ click: false });
    document.querySelector<HTMLElement>('#b')!.click();

    expect(await hub.types()).toEqual(['page_view']);
  });

  it('tout débrancher rend la page silencieuse', async () => {
    document.body.innerHTML = '<button id="b">OK</button>';
    start();
    stop();

    document.querySelector<HTMLElement>('#b')!.click();
    window.history.pushState(null, '', '/ailleurs');
    window.dispatchEvent(new Event('pagehide'));

    expect(await hub.types()).toEqual(['page_view']);
  });

  it('remonte les échecs des événements collectés à onError, sans lever', async () => {
    const onError = vi.fn();
    hub = createHub({ ok: false });
    analytics = new Analytics({
      apiKey: API_KEY,
      endpoint: ENDPOINT,
      onError,
    });
    start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(String(onError.mock.calls[0]?.[0])).toContain('projet inconnu');
  });

  describe('track()', () => {
    it("transmet les properties de l'appelant telles quelles", async () => {
      await analytics.track('checkout_completed', { plan: 'pro', cart: 49 });

      const [event] = await hub.envelopes();
      expect(event).toMatchObject({
        type: 'checkout_completed',
        properties: { plan: 'pro', cart: 49 },
        attributes: { 'page.path': '/' },
      });
    });

    it('rejette quand le hub refuse, statut et corps compris', async () => {
      hub = createHub({ ok: false });

      await expect(analytics.track('nimporte_quoi')).rejects.toThrow(
        /422.*projet inconnu/s,
      );
    });
  });

  describe('la visite en cours', () => {
    it('est tenue à disposition sans consentement, et sans cookie', async () => {
      // Le hub ne rend aucun identifiant durable ici : c'est exactement le cas
      // d'un visiteur qui n'a rien accepté, et c'est là que la session sert.
      await analytics.track('checkout_started');

      expect(analytics.getSessionId()).toBe(SESSION_ID);
      // Rien n'est inscrit sur le terminal, et c'est toute la propriété qui
      // rend ce chemin utilisable sans consentement. La recopier « par
      // symétrie » avec le visitorId la détruirait.
      expect(document.cookie).not.toContain(SESSION_ID);
    });

    it('reste disponible après le premier événement', async () => {
      // Le miroir du visitorId court-circuite quand rien n'a changé — sans
      // consentement, c'est à *chaque* événement. La session ne doit pas être
      // emportée par cette garde.
      await analytics.track('premier');
      await analytics.track('second');

      expect(analytics.getSessionId()).toBe(SESSION_ID);
    });
  });

  describe('la copie du visitorId', () => {
    const VISITOR_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    /** jsdom garde ses cookies d'un test à l'autre : on repart du vide. */
    beforeEach(() => {
      document.cookie = 'eh_visitor_id=; Path=/; Max-Age=0';
    });

    it('dépose ce que le hub rend, et le tient à disposition', async () => {
      hub.setVisitorId(VISITOR_ID);

      await analytics.track('checkout_started');

      // Le cookie pour le backend du site, le getter pour son JS. Les deux
      // portent la même valeur, et aucune n'a été forgée ici.
      expect(document.cookie).toContain(`eh_visitor_id=${VISITOR_ID}`);
      expect(analytics.getVisitorId()).toBe(VISITOR_ID);
    });

    it('efface la copie dès que le hub cesse d’en rendre une', async () => {
      hub.setVisitorId(VISITOR_ID);
      await analytics.track('avant');

      // Le visiteur retire son consentement : le hub ne rend plus rien.
      hub.setVisitorId(undefined);
      await analytics.track('apres');

      expect(document.cookie).not.toContain('eh_visitor_id=');
      expect(analytics.getVisitorId()).toBeUndefined();
    });

    it('efface une copie laissée par une visite précédente', async () => {
      // Le cas que le drapeau interne existe pour couvrir : le consentement a
      // été retiré entre deux chargements de page, donc rien en mémoire ne
      // signale qu'il y a quelque chose à effacer. Sans lui, cette copie
      // survivrait 400 jours et continuerait de partir dans les paiements.
      document.cookie = `eh_visitor_id=${VISITOR_ID}; Path=/`;

      await analytics.track('premier_de_la_page');

      expect(document.cookie).not.toContain('eh_visitor_id=');
    });

    it('ne réécrit rien tant que la valeur ne change pas', async () => {
      hub.setVisitorId(VISITOR_ID);
      await analytics.track('premier');

      const cookie = vi.spyOn(document, 'cookie', 'set');
      await analytics.track('second');

      // La copie porte déjà sa propre durée de vie : la réécrire à chaque
      // événement n'ajouterait rien.
      expect(cookie).not.toHaveBeenCalled();
      cookie.mockRestore();
    });

    it('suit aussi les événements collectés, pas seulement track()', async () => {
      hub.setVisitorId(VISITOR_ID);

      start();

      await vi.waitFor(() =>
        expect(document.cookie).toContain(`eh_visitor_id=${VISITOR_ID}`),
      );
    });
  });
});

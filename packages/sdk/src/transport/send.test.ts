import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubSendBeacon } from '../test-helpers.ts';
import { beaconEvent, postEvent, type EventEnvelope } from './send.ts';

const ENDPOINT = 'https://hub.test/v1/events';

const ENVELOPE: EventEnvelope = {
  apiKey: 'eh_pk_2e95b1b62a96443a919f2b3661106689',
  type: 'page_leave',
  occurredAt: '2026-08-22T15:00:00.000Z',
  attributes: {},
  properties: { 'leave.reason': 'pagehide' },
};

/** Un `Request` dont le prototype expose — ou non — `keepalive`. */
function stubRequest({ keepalive }: { keepalive: boolean }): void {
  class FakeRequest {}
  if (keepalive) {
    Object.defineProperty(FakeRequest.prototype, 'keepalive', { value: false });
  }

  vi.stubGlobal('Request', FakeRequest);
}

describe('beaconEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('poste en keepalive quand le navigateur le supporte', () => {
    stubRequest({ keepalive: true });
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const sendBeacon = stubSendBeacon();

    beaconEvent(ENDPOINT, ENVELOPE);

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ENVELOPE),
      keepalive: true,
    });
    // `sendBeacon` perdrait son preflight au déchargement : on ne l'emprunte pas
    // tant que `keepalive` est disponible.
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("retombe sur sendBeacon quand keepalive n'existe pas", async () => {
    stubRequest({ keepalive: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sendBeacon = stubSendBeacon();

    beaconEvent(ENDPOINT, ENVELOPE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledOnce();

    const [endpoint, blob] = sendBeacon.mock.calls[0] as unknown as [
      string,
      Blob,
    ];
    expect(endpoint).toBe(ENDPOINT);
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(JSON.stringify(ENVELOPE));
  });

  it('avale les échecs plutôt que de laisser un rejet non géré', () => {
    stubRequest({ keepalive: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('réseau coupé'))),
    );

    expect(() => {
      beaconEvent(ENDPOINT, ENVELOPE);
    }).not.toThrow();
  });
});

describe('postEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lève avec le statut et le corps quand le hub refuse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: () => Promise.resolve('{"issues":[{"path":"occurredAt"}]}'),
        }),
      ),
    );

    await expect(postEvent(ENDPOINT, ENVELOPE)).rejects.toThrow(
      /400 Bad Request.*occurredAt/s,
    );
  });
});

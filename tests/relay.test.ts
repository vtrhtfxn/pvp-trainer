import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPEN_RELAY, iceConfig, loadRelay, parseRelayUrls, routeOf, saveRelay } from '../src/net/relay';

function fakeStorage() {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

describe('online relay (TURN fallback)', () => {
  beforeEach(fakeStorage);
  afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

  it('tries direct routes first, then the player’s relay, then the free one', () => {
    const c = iceConfig(null);
    const urls = c.iceServers!.map((s) => [s.urls].flat().join(' '));
    expect(urls[0]).toMatch(/^stun:/);
    expect(c.iceServers![c.iceServers!.length - 1]).toBe(OPEN_RELAY);
    // 'all' lets WebRTC prefer a direct route and only use a relay when that fails.
    expect(c.iceTransportPolicy).toBe('all');
    const own = iceConfig({ urls: 'turn:my.relay:3478, turns:my.relay:443?transport=tcp', username: 'u', credential: 'p' });
    const mine = own.iceServers![own.iceServers!.length - 2];
    expect(mine).toEqual({ urls: ['turn:my.relay:3478', 'turns:my.relay:443?transport=tcp'], username: 'u', credential: 'p' });
    expect(iceConfig(null, true).iceTransportPolicy).toBe('relay');
  });

  it('the built-in relay listens on web ports, over UDP, TCP and TLS', () => {
    const urls = [OPEN_RELAY.urls].flat();
    expect(urls.some((u) => u.startsWith('turn:') && u.endsWith(':80'))).toBe(true);
    expect(urls.some((u) => u.includes('transport=tcp'))).toBe(true);
    expect(urls.some((u) => u.startsWith('turns:') && u.includes(':443'))).toBe(true);
  });

  it('keeps only TURN URLs from what the player typed', () => {
    expect(parseRelayUrls(' turn:a:3478,https://x  stun:b:19302\nTURNS:c:443?transport=tcp ')).toEqual(['turn:a:3478', 'TURNS:c:443?transport=tcp']);
    expect(parseRelayUrls('')).toEqual([]);
  });

  it('saves, loads and removes the player’s relay', () => {
    expect(loadRelay()).toBeNull();
    expect(saveRelay({ urls: 'nonsense', username: '', credential: '' })).toBeNull();
    expect(loadRelay()).toBeNull();
    const r = { urls: 'turn:my.relay:3478', username: 'u', credential: 'p' };
    expect(saveRelay(r)).toEqual(r);
    expect(loadRelay()).toEqual(r);
    expect(iceConfig().iceServers!.some((s) => s.username === 'u')).toBe(true);
    saveRelay(null);
    expect(loadRelay()).toBeNull();
  });

  it('tells a relayed connection from a direct one by its selected candidate pair', async () => {
    const pc = (type: string) =>
      ({
        getStats: async () =>
          new Map<string, Record<string, unknown>>([
            ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
            ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042 }],
            ['L', { id: 'L', type: 'local-candidate', candidateType: type }],
            ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx' }],
          ]),
      }) as unknown as RTCPeerConnection;
    expect(await routeOf(pc('relay'))).toEqual({ route: 'relay', rtt: 42 });
    expect(await routeOf(pc('host'))).toEqual({ route: 'direct', rtt: 42 });
    expect(await routeOf(null)).toBeNull();
  });
});

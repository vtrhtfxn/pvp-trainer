/**
 * How online games find a path between two players.
 *
 * WebRTC tries every route at once and keeps the best that works: straight across the local
 * network, then straight across the internet (STUN tells each side its public address), and only
 * when both of those are blocked (strict school or office Wi-Fi, some phone hotspots, carrier NAT
 * on both sides) through a TURN relay, a server that passes the game's packets along. A relayed
 * game works the same, with a little more ping.
 *
 * The built-in relay is Metered's free public Open Relay. A player can add their own relay
 * (Multiplayer → Relay server) — any TURN server, e.g. a free Metered or Cloudflare account —
 * which is then tried alongside it.
 */

export interface RelayServer {
  /** `turn:host:port`, `turns:host:443?transport=tcp`, … (several separated by spaces or commas). */
  urls: string;
  username: string;
  credential: string;
}

const STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Metered's Open Relay Project: a free shared TURN service (20 GB/month) on ports 80 and 443,
 * over UDP, TCP and TLS, so it gets through firewalls that only let web traffic out.
 */
export const OPEN_RELAY: RTCIceServer = {
  urls: [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:443',
    'turn:openrelay.metered.ca:443?transport=tcp',
    'turns:openrelay.metered.ca:443?transport=tcp',
  ],
  username: 'openrelayproject',
  credential: 'openrelayproject',
};

const KEY = 'pvp-trainer.net.relay';

/** Splits what a person typed into TURN URLs, keeping only ones a browser accepts. */
export function parseRelayUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^turns?:[^\s]+$/i.test(u));
}

export function loadRelay(): RelayServer | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null') as RelayServer | null;
    if (!r || typeof r.urls !== 'string' || !parseRelayUrls(r.urls).length) return null;
    return { urls: r.urls, username: String(r.username ?? ''), credential: String(r.credential ?? '') };
  } catch {
    return null;
  }
}

/** Saves the player's own relay; empty URLs remove it. Returns what is now in use. */
export function saveRelay(r: RelayServer | null): RelayServer | null {
  const ok = r && parseRelayUrls(r.urls).length ? r : null;
  try {
    if (ok) localStorage.setItem(KEY, JSON.stringify(ok));
    else localStorage.removeItem(KEY);
  } catch {
    /* blocked storage: it still applies to this session */
  }
  return ok;
}

/**
 * The ICE servers for a new connection: STUN for direct routes, then the player's own relay (if
 * any) and the free one as fallbacks. `relayOnly` forces everything through a relay (tests).
 */
export function iceConfig(own: RelayServer | null = loadRelay(), relayOnly = false): RTCConfiguration {
  const servers: RTCIceServer[] = [...STUN];
  if (own) servers.push({ urls: parseRelayUrls(own.urls), username: own.username, credential: own.credential });
  servers.push(OPEN_RELAY);
  return { iceServers: servers, iceTransportPolicy: relayOnly ? 'relay' : 'all' };
}

export type Route = 'direct' | 'relay';

/** Which route a live connection took: its selected candidate pair, read from WebRTC's stats. */
export async function routeOf(pc: RTCPeerConnection | undefined | null): Promise<{ route: Route; rtt: number | null } | null> {
  if (!pc) return null;
  try {
    const stats = await pc.getStats();
    let pairId: string | null = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    let pair: { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number } | null = null;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) pair = s;
    });
    if (!pair) return null;
    const p = pair as { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number };
    let relayed = false;
    stats.forEach((s) => {
      if ((s.id === p.localCandidateId || s.id === p.remoteCandidateId) && s.candidateType === 'relay') relayed = true;
    });
    const rtt = typeof p.currentRoundTripTime === 'number' ? Math.round(p.currentRoundTripTime * 1000) : null;
    return { route: relayed ? 'relay' : 'direct', rtt };
  } catch {
    return null;
  }
}

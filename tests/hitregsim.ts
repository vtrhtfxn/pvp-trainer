/**
 * Hit registration over a simulated network. Client 1 chases client 0 and clicks whenever its
 * crosshair is on the opponent *as drawn on its screen* with a full attack cooldown — a perfect
 * player. Client 0 strafes and jumps around it. We count how many of those on-screen hits the
 * server (Duel) actually lands, and how long it takes until the attacker sees the hit.
 */
import { Rng } from '../src/core/rng';
import { renderedPick } from '../src/game/combat';
import { Duel } from '../src/net/Duel';
import { NetMatch } from '../src/net/NetMatch';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import { FakeNet, Link, type LinkProfile } from './netsim';

const TICK = 50;

export interface HitregOptions {
  seconds: number;
  seed: number;
  /** One-way links (client → server, server → client). */
  up: LinkProfile;
  down: LinkProfile;
  fps: [number, number];
  /** Measured ping fed to the server (it normally learns it from ping/pong). */
  ping?: number;
  /** Resolve swings as they arrive (the Lobby does); false = only on the tick. */
  immediate?: boolean;
}

export interface HitregResult {
  /** Clicks that hit on the attacker's screen. */
  claims: number;
  /** Of those, the server landed. */
  landed: number;
  /** Swings the server made into the opponent's hurt immunity (clicks a full cooldown never allowed). */
  wasted: number;
  /** Hits the server landed per on-screen hit. */
  rate: number;
  /** Click → the attacker sees the opponent flash red, ms (median, 90th percentile). */
  feedbackP50: number;
  feedbackP90: number;
}

const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export function simulateHitreg(o: HitregOptions): HitregResult {
  const rng = new Rng(o.seed);
  const horizon = o.seconds * 1000 + 5000;
  const duel = new Duel(['Runner', 'Attacker'], 'sword');
  const nets = [new FakeNet(), new FakeNet()];
  const clients = [0, 1].map((i) => new NetMatch(nets[i] as never, i, 'sword'));
  const up = [new Link(o.up, rng, horizon), new Link(o.up, rng, horizon)];
  const down = [new Link(o.down, rng, horizon), new Link(o.down, rng, horizon)];
  for (const c of clients) c.handle({ t: 'start', countdown: 3, kit: 'sword' });
  const ping = o.ping ?? Math.round(o.up.base + o.down.base);
  duel.setPing(0, ping);
  duel.setPing(1, ping);
  let simNow = 0;
  duel.clock = () => simNow;
  for (const c of clients) c.clock = () => simNow;

  let due = TICK;
  let serverTick = 0;
  const frameMs = o.fps.map((f) => 1000 / f);
  const nextFrame = [0, frameMs[1] * 0.41];
  const acc = [0, 0];
  const lastFrame = [0, 0];

  let claims = 0;
  let landed = 0;
  const pending: number[] = [];
  const feedback: number[] = [];
  let lastHurt = 0; // the opponent's hurtTime on the attacker's screen last frame
  let serverHits = 0;

  // Why the server's swings went the way they did.
  const outcomes: Record<string, number> = {};
  const ev = duel.fighters[1].events;
  const push = ev.push.bind(ev);
  ev.push = (...items) => {
    for (const it of items) outcomes[it.type] = (outcomes[it.type] ?? 0) + 1;
    return push(...items);
  };
  const serverStep = (now: number) => {
    const before = duel.fighters[1].stats.hits;
    for (const e of duel.tick()) {
      if (e.motion) down[e.motion.to].send(now, { t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
      if (e.teleport) down[e.teleport.to].send(now, { t: 'teleport', ...e.teleport });
    }
    serverHits += duel.fighters[1].stats.hits - before;
    // Keep the runner alive.
    const r = duel.fighters[0];
    if (r.health < 10) r.health = r.maxHealth;
    const s = duel.stateMessage(++serverTick, [ping, ping]);
    down[0].send(now, s);
    down[1].send(now, s);
    for (const { to, msg } of duel.takeOutbox()) {
      if (to < 0) {
        down[0].send(now, msg);
        down[1].send(now, msg);
      } else down[to].send(now, msg);
    }
  };

  const end = o.seconds * 1000 + 4000;
  for (let now = 0; now < end; now++) {
    simNow = now;
    for (let i = 0; i < 2; i++) {
      for (const m of up[i].take(now)) {
        const relay = duel.receive(i, m as ClientMsg);
        if (relay) down[1 - i].send(now, relay);
        if ((m as ClientMsg).t === 'attack' && o.immediate !== false) {
          // As the Lobby does: resolve the swing now and send the result at once.
          const before = duel.fighters[i].stats.hits;
          const { hit, events } = duel.resolveClicksNow(i);
          if (i === 1) serverHits += duel.fighters[1].stats.hits - before;
          if (hit) {
            for (const e of events) if (e.motion) down[e.motion.to].send(now, { t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
            const st = duel.stateMessage(serverTick, [ping, ping]);
            down[0].send(now, st);
            down[1].send(now, st);
          }
        }
      }
    }
    let n = 0;
    while (now >= due && n < 4) {
      serverStep(now);
      due += TICK;
      n++;
    }
    for (let i = 0; i < 2; i++) {
      if (now < nextFrame[i]) continue;
      const dt = Math.min(100, now - lastFrame[i]);
      lastFrame[i] = now;
      nextFrame[i] += frameMs[i] * (0.9 + rng.next() * 0.2);
      const c = clients[i];
      for (const m of down[i].take(now)) c.handle(m as ServerMsg);
      acc[i] += dt;
      while (acc[i] >= TICK) {
        const p = c.player;
        const b = c.bot;
        if (c.phase === 'fight') {
          const dx = b.pos.x - p.pos.x;
          const dz = b.pos.z - p.pos.z;
          const d = Math.hypot(dx, dz);
          if (i === 0) {
            // Runner: circle-strafe the attacker, change direction now and then, jump sometimes.
            p.yaw = yawTo(dx, dz);
            const dir = Math.floor(now / 700) % 2 ? 1 : -1;
            p.input = { forward: d > 3.5 ? 1 : d < 2 ? -1 : 0, strafe: dir, jump: rng.next() < 0.04, sneak: false, sprint: true };
          } else {
            // Attacker: close in to about 2.6 blocks.
            p.input = { forward: d > 2.6 ? 1 : 0, strafe: 0, jump: false, sneak: false, sprint: d > 2.6 };
          }
        }
        c.tick();
        acc[i] -= TICK;
        for (const m of nets[i].out) up[i].send(now, m);
        nets[i].out.length = 0;
      }
      if (i !== 1 || c.phase !== 'fight') continue;
      // The attacker's frame: aim at the opponent exactly as drawn, click on a full cooldown.
      const a = acc[i] / TICK;
      const p = c.player;
      const b = c.bot;
      const bx = b.prevPos.x + (b.pos.x - b.prevPos.x) * a;
      const bz = b.prevPos.z + (b.pos.z - b.prevPos.z) * a;
      const px = p.prevPos.x + (p.pos.x - p.prevPos.x) * a;
      const pz = p.prevPos.z + (p.pos.z - p.prevPos.z) * a;
      p.yaw = yawTo(bx - px, bz - pz);
      p.pitch = 0.15;
      // The opponent flashing red on our screen: the hit is confirmed.
      // A new flash: hurtTime jumped up (it only ever counts down otherwise).
      const fresh = b.hurtTime > lastHurt;
      lastHurt = b.hurtTime;
      if (fresh) {
        const t = pending.shift();
        if (t !== undefined) feedback.push(now - t);
        pending.length = 0;
      }
      if (now < 5000 || now > o.seconds * 1000 || p.attackStrengthScale(a) < 1) continue;
      const picked = renderedPick(p, b, a);
      if (picked < 0) continue;
      claims++;
      pending.push(now);
      c.queueClick(picked, a);
      for (const m of nets[i].out) up[i].send(now, m);
      nets[i].out.length = 0;
    }
  }
  landed = serverHits;
  feedback.sort((x, y) => x - y);
  const pct = (q: number) => (feedback.length ? feedback[Math.min(feedback.length - 1, Math.floor(feedback.length * q))] : NaN);
  return { claims, landed, wasted: outcomes.noDamage ?? 0, rate: claims ? Math.round((landed / claims) * 1000) / 1000 : 0, feedbackP50: pct(0.5), feedbackP90: pct(0.9) };
}

export const NET: Record<string, { up: LinkProfile; down: LinkProfile }> = {
  /** Same city, good broadband: ~20 ms round trip. */
  near: { up: { base: 9, jitter: 6, stallEvery: 0, stall: [0, 0] }, down: { base: 9, jitter: 6, stallEvery: 0, stall: [0, 0] } },
  /** Across a country: ~60 ms round trip, Wi-Fi jitter. */
  far: { up: { base: 28, jitter: 25, stallEvery: 4000, stall: [40, 100] }, down: { base: 28, jitter: 25, stallEvery: 4000, stall: [40, 100] } },
};

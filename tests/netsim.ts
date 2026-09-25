/**
 * A real-time model of an online duel over a flaky network, for measuring how smoothly each
 * client draws its opponent.
 *
 * Both clients run their own frame loops (at their own frame rates, ticking the sim from an
 * accumulator exactly like Game.frame), the server ticks on its own timer, and every message
 * crosses a link with latency, jitter and occasional Wi-Fi stalls that release everything held
 * up at once (TCP keeps the order). Client 0 runs around; client 1 is the observer whose drawn
 * opponent is recorded every frame.
 */
import { Rng } from '../src/core/rng';
import { Duel } from '../src/net/Duel';
import { NetMatch } from '../src/net/NetMatch';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';

const TICK = 50;

export interface LinkProfile {
  /** One-way base latency, ms. */
  base: number;
  /** Extra random latency: most packets get a little, a few get up to this much, ms. */
  jitter: number;
  /** Mean time between stalls (Wi-Fi retries, power save), ms; 0 = never. */
  stallEvery: number;
  /** Stall length range, ms. */
  stall: [number, number];
}

export interface SimOptions {
  seconds: number;
  seed: number;
  up: LinkProfile;
  down: LinkProfile;
  /** Frame rates of the two clients. */
  fps: [number, number];
  /** Frame hitches on both clients (a weak PC, a GC pause): mean gap and length, ms. */
  hitchEvery?: number;
  hitch?: [number, number];
  /** Server timer hiccups: mean time between them and how late the timer fires, ms. */
  serverHiccupEvery?: number;
  serverHiccup?: [number, number];
}

export interface SimResult {
  /** Frames where the drawn opponent moved impossibly fast (a visible teleport). */
  teleports: number;
  /** Frames the opponent stood still although they were really moving (per 1000 frames). */
  freezePerMille: number;
  /** Fastest drawn speed, blocks/s. */
  maxSpeed: number;
  /** Fastest the runner really went (per tick), blocks/s — the yardstick for maxSpeed. */
  truthMax: number;
  /** How far behind the truth the opponent is drawn on average, ms. */
  delayMs: number;
  /** RMS distance from the truth at that delay, blocks. */
  rmsError: number;
  frames: number;
}

class Link {
  private last = 0;
  private stalls: [number, number][] = [];
  readonly queue: { at: number; msg: string }[] = [];

  constructor(
    private readonly p: LinkProfile,
    private readonly rng: Rng,
    horizon: number,
  ) {
    if (p.stallEvery > 0) {
      for (let t = rng.next() * p.stallEvery; t < horizon; t += p.stallEvery * (0.5 + rng.next())) {
        this.stalls.push([t, t + p.stall[0] + rng.next() * (p.stall[1] - p.stall[0])]);
      }
    }
  }

  send(now: number, msg: unknown) {
    // Heavy-tailed jitter: usually small, sometimes most of `jitter`.
    const r = this.rng.next();
    let at = now + this.p.base + this.p.jitter * r * r * r;
    for (const [s, e] of this.stalls) if (at >= s && at < e) at = e;
    // TCP delivers in order: nothing overtakes what was sent before it.
    at = Math.max(at, this.last + 0.01);
    this.last = at;
    this.queue.push({ at, msg: JSON.stringify(msg) });
  }

  take(now: number): unknown[] {
    const out: unknown[] = [];
    while (this.queue.length && this.queue[0].at <= now) out.push(JSON.parse(this.queue.shift()!.msg));
    return out;
  }
}

class FakeNet {
  connected = true;
  out: ClientMsg[] = [];
  send(m: ClientMsg) {
    this.out.push(m);
  }
}

export function simulate(o: SimOptions): SimResult {
  const rng = new Rng(o.seed);
  const horizon = o.seconds * 1000 + 5000;
  const duel = new Duel(['A', 'B'], 'sword');
  const nets = [new FakeNet(), new FakeNet()];
  const clients = [0, 1].map((i) => new NetMatch(nets[i] as never, i, 'sword'));
  const up = [new Link(o.up, rng, horizon), new Link(o.up, rng, horizon)];
  const down = [new Link(o.down, rng, horizon), new Link(o.down, rng, horizon)];
  for (let i = 0; i < 2; i++) clients[i].handle({ t: 'start', countdown: 3, kit: 'sword' });
  duel.setPing(0, (o.up.base + o.down.base) | 0);
  duel.setPing(1, (o.up.base + o.down.base) | 0);

  // Server timer: every 50 ms, sometimes late.
  let nextServer = TICK;
  let due = TICK;
  let serverTick = 0;
  let simNow = 0;
  duel.clock = () => simNow;
  for (const c of clients) c.clock = () => simNow;
  let hiccupAt = 0;
  const hiccups: number[] = [];
  if (o.serverHiccupEvery) for (let t = rng.next() * o.serverHiccupEvery; t < horizon; t += o.serverHiccupEvery * (0.5 + rng.next())) hiccups.push(t);

  // Client frame loops.
  const frameMs = o.fps.map((f) => 1000 / f);
  const nextFrame = [0, frameMs[1] * 0.37];
  const acc = [0, 0];
  const lastFrame = [0, 0];

  // Truth: where client 0 really was, per its own tick, stamped with the time.
  const truth: { t: number; x: number; z: number }[] = [];
  const drawn: { t: number; x: number; z: number }[] = [];
  let fightStart = -1;
  let clientTicks = 0;

  const moveInput = (c: NetMatch, t: number) => {
    const p = c.player;
    // Run in a circle (so the arena never ends), strafing and jumping now and then.
    p.yaw += 0.045;
    const phase = Math.floor(t / 800) % 3;
    p.input = { forward: 1, strafe: phase === 0 ? 1 : phase === 1 ? -1 : 0, jump: Math.floor(t / 1300) % 4 === 0, sneak: false, sprint: true };
  };

  const ping = (o.up.base + o.down.base) | 0;
  const serverStep = (now: number) => {
    for (const e of duel.tick()) {
      if (e.motion) down[e.motion.to].send(now, { t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
      if (e.teleport) down[e.teleport.to].send(now, { t: 'teleport', ...e.teleport });
    }
    const s = duel.stateMessage(++serverTick, [ping, ping]);
    down[0].send(now, s);
    down[1].send(now, s);
  };

  const end = o.seconds * 1000 + 6000;
  for (let now = 0; now < end; now += 1) {
    simNow = now;
    // Messages reach the server as they arrive; moves are relayed on at once.
    for (let i = 0; i < 2; i++) {
      for (const m of up[i].take(now)) {
        const relay = duel.receive(i, m as ClientMsg);
        if (relay) down[1 - i].send(now, relay);
      }
    }
    // Server tick on a fixed schedule; a late timer (the host busy or throttled) catches up.
    if (now >= nextServer) {
      if (hiccupAt < hiccups.length && hiccups[hiccupAt] <= now && o.serverHiccup) {
        hiccupAt++;
        nextServer = now + o.serverHiccup[0] + rng.next() * (o.serverHiccup[1] - o.serverHiccup[0]);
      } else {
        let n = 0;
        while (now >= due && n < 4) {
          serverStep(now);
          due += TICK;
          n++;
        }
        if (now - due > TICK * 4) due = now + TICK;
        nextServer = Math.max(now + 1, due);
      }
    }
    for (let i = 0; i < 2; i++) {
      if (now < nextFrame[i]) continue;
      // A frame: messages that arrived since the last one, then the sim, then the draw.
      const dt = Math.min(100, now - lastFrame[i]);
      lastFrame[i] = now;
      nextFrame[i] += frameMs[i] * (0.9 + rng.next() * 0.2);
      if (o.hitchEvery && o.hitch && rng.next() < frameMs[i] / o.hitchEvery) nextFrame[i] += o.hitch[0] + rng.next() * (o.hitch[1] - o.hitch[0]);
      const c = clients[i];
      for (const m of down[i].take(now)) c.handle(m as ServerMsg);
      acc[i] += dt;
      while (acc[i] >= TICK) {
        if (i === 0 && c.phase === 'fight') moveInput(c, now);
        c.tick();
        acc[i] -= TICK;
        for (const m of nets[i].out) up[i].send(now, m);
        nets[i].out.length = 0;
        if (i === 0 && c.phase === 'fight') {
          if (fightStart < 0) fightStart = now;
          truth.push({ t: now, x: c.player.pos.x, z: c.player.pos.z });
          clientTicks++;
        }
      }
      if (i === 1 && fightStart >= 0 && now > fightStart + 3000) {
        const b = c.bot;
        const a = acc[i] / TICK;
        const info = { viewQ: +c.viewQ.toFixed(2), delay: Math.round(c.delayMs), acc: acc[i] };
        drawn.push({ t: now, x: b.prevPos.x + (b.pos.x - b.prevPos.x) * a, z: b.prevPos.z + (b.pos.z - b.prevPos.z) * a, info } as { t: number; x: number; z: number });
      }
    }
  }

  // Frame-to-frame speed of what the observer saw.
  let teleports = 0;
  let freezes = 0;
  let maxSpeed = 0;
  const truthAt = (t: number) => {
    let lo = 0;
    let hi = truth.length - 1;
    if (t <= truth[0].t) return truth[0];
    if (t >= truth[hi].t) return truth[hi];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (truth[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = truth[lo];
    const b = truth[hi];
    const f = (t - a.t) / (b.t - a.t);
    return { t, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };
  let truthMax = 0;
  for (let k = 1; k < truth.length; k++) {
    const dt = (truth[k].t - truth[k - 1].t) / 1000;
    if (dt > 0.03) truthMax = Math.max(truthMax, Math.hypot(truth[k].x - truth[k - 1].x, truth[k].z - truth[k - 1].z) / 0.05);
  }
  for (let k = 1; k < drawn.length; k++) {
    const a = drawn[k - 1];
    const b = drawn[k];
    const dt = (b.t - a.t) / 1000;
    const v = Math.hypot(b.x - a.x, b.z - a.z) / dt;
    maxSpeed = Math.max(maxSpeed, v);
    // Well past the fastest the runner really moved: a visible jump.
    if (v > truthMax * 1.3) {
      teleports++;
      if (process.env.NETSIM_DEBUG) process.stderr.write(`jump at ${b.t} dt=${(dt * 1000).toFixed(0)} v=${v.toFixed(1)} ${JSON.stringify((b as { info?: unknown }).info)}\n`);
    }
    const ta = truthAt(b.t - 150);
    const tb = truthAt(b.t - 150 - dt * 1000);
    const tv = Math.hypot(ta.x - tb.x, ta.z - tb.z) / dt;
    if (v < 0.3 && tv > 3) freezes++;
  }
  // Best-fitting constant delay, and the error left at it.
  let best = { d: 0, err: Infinity };
  for (let d = 0; d <= 600; d += 10) {
    let s = 0;
    for (const p of drawn) {
      const q = truthAt(p.t - d);
      s += (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
    }
    const err = Math.sqrt(s / drawn.length);
    if (err < best.err) best = { d, err };
  }
  void clientTicks;
  return {
    truthMax: Math.round(truthMax * 10) / 10,
    teleports,
    freezePerMille: Math.round((freezes / drawn.length) * 1000),
    maxSpeed: Math.round(maxSpeed * 10) / 10,
    delayMs: best.d,
    rmsError: Math.round(best.err * 1000) / 1000,
    frames: drawn.length,
  };
}

export const PROFILES: Record<string, Pick<SimOptions, 'up' | 'down' | 'serverHiccupEvery' | 'serverHiccup' | 'hitchEvery' | 'hitch'>> = {
  wired: { up: { base: 1, jitter: 2, stallEvery: 0, stall: [0, 0] }, down: { base: 1, jitter: 2, stallEvery: 0, stall: [0, 0] } },
  wifi: { up: { base: 4, jitter: 40, stallEvery: 3000, stall: [60, 150] }, down: { base: 4, jitter: 40, stallEvery: 3000, stall: [60, 150] } },
  badWifi: { up: { base: 8, jitter: 90, stallEvery: 1200, stall: [120, 350] }, down: { base: 8, jitter: 90, stallEvery: 1200, stall: [120, 350] } },
  hitchyPcs: {
    up: { base: 4, jitter: 40, stallEvery: 3000, stall: [60, 150] },
    down: { base: 4, jitter: 40, stallEvery: 3000, stall: [60, 150] },
    hitchEvery: 2500,
    hitch: [120, 400],
  },
  sleepyHost: {
    up: { base: 4, jitter: 30, stallEvery: 4000, stall: [60, 120] },
    down: { base: 4, jitter: 30, stallEvery: 4000, stall: [60, 120] },
    serverHiccupEvery: 1500,
    serverHiccup: [100, 300],
  },
};

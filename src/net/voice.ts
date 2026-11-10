import { Peer, type MediaConnection } from 'peerjs';
import { peerOptions } from './p2p';

/**
 * Voice Chat mod: everyone in an online room who has the mod on talks to everyone else, straight
 * from player to player (WebRTC audio calls through PeerJS, the same service online play uses to
 * find each other). The room only passes around each player's call address ("voice" messages);
 * the sound itself never goes through the host.
 *
 * Between two players exactly one calls: the one whose address sorts first.
 */

export interface VoiceSettings {
  /** 'ptt': only while the key is held; 'voice': whenever you're louder than `threshold`. */
  mode: 'ptt' | 'voice' | 'muted';
  threshold: number;
  micGain: number;
  volume: number;
  proximity: boolean;
  /** Blocks at which a voice fades out completely (proximity). */
  range: number;
}

interface Remote {
  name: string;
  call: MediaConnection;
  gain?: GainNode;
  analyser?: AnalyserNode;
  /** Chrome only plays a WebRTC stream into Web Audio while some media element holds it. */
  el?: HTMLAudioElement;
  level: number;
}

export type VoiceState = 'off' | 'starting' | 'on' | 'error';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function validVoiceId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** The level (0..1, RMS) an analyser hears right now. */
function levelOf(a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export class VoiceChat {
  state: VoiceState = 'off';
  /** Why it couldn't start (shown in the HUD). */
  error = '';
  /** Your own call address, once there is one. */
  id = '';
  private peer: Peer | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private micGain: GainNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outStream: MediaStream | null = null;
  private readonly remotes = new Map<string, Remote>();
  /** Addresses of the others in the room, by name (from the room's "voice" messages). */
  private readonly known = new Map<string, string>();
  private readonly buf = new Float32Array(512);
  /** You are sending your voice right now. */
  transmitting = false;
  /** Voice activation keeps the mic open a moment after you stop, so words aren't cut off. */
  private hold = 0;
  private generation = 0;

  /** Starts the mic and your call address; `announce` tells the room the address. */
  async start(announce: (id: string) => void): Promise<void> {
    if (this.state === 'starting' || this.state === 'on') return;
    const gen = ++this.generation;
    this.state = 'starting';
    this.error = '';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access');
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (gen !== this.generation) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mic = mic;
      const ctx = new AudioContext();
      this.ctx = ctx;
      const src = ctx.createMediaStreamSource(mic);
      this.micGain = ctx.createGain();
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      const dest = ctx.createMediaStreamDestination();
      src.connect(this.micAnalyser);
      src.connect(this.micGain).connect(dest);
      this.outStream = dest.stream;
      for (const t of this.outStream.getAudioTracks()) t.enabled = false;
      const peer = new Peer(peerOptions());
      this.peer = peer;
      peer.on('open', (id) => {
        if (gen !== this.generation) return;
        this.id = id;
        this.state = 'on';
        announce(id);
        for (const [name, other] of this.known) this.maybeCall(name, other);
      });
      peer.on('call', (call) => {
        if (gen !== this.generation || !this.outStream) {
          call.close();
          return;
        }
        // Only someone the room told us about may talk to us.
        const name = [...this.known].find(([, id]) => id === call.peer)?.[0];
        if (!name) {
          call.close();
          return;
        }
        call.answer(this.outStream);
        this.track(name, call);
      });
      peer.on('disconnected', () => {
        if (gen === this.generation && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.on('error', (e) => {
        // A call to someone who left fails on its own; only a broken connection to the service matters.
        const type = (e as { type?: string }).type;
        if (type === 'peer-unavailable') return;
        if (this.state === 'starting') this.fail(`Voice chat could not connect (${type ?? 'network'})`);
      });
    } catch (e) {
      if (gen !== this.generation) return;
      const name = (e as { name?: string }).name;
      this.fail(
        name === 'NotAllowedError'
          ? 'Microphone blocked — allow it for this game (in the desktop app, download the newest version)'
          : name === 'NotFoundError'
            ? 'No microphone found'
            : (e as Error).message || 'Microphone unavailable',
      );
    }
  }

  private fail(msg: string) {
    this.stop();
    this.state = 'error';
    this.error = msg;
  }

  /** The room says `name` can be called at `id` ('' = they left or switched voice off). */
  setPeer(name: string, id: string) {
    if (!id) {
      this.known.delete(name);
      this.hangUp(name);
      return;
    }
    if (!validVoiceId(id)) return;
    if (this.known.get(name) === id) return;
    this.known.set(name, id);
    this.hangUp(name);
    this.maybeCall(name, id);
  }

  private maybeCall(name: string, id: string) {
    if (!this.peer || !this.id || !this.outStream || this.remotes.has(name)) return;
    if (this.id >= id) return; // they call us
    const call = this.peer.call(id, this.outStream);
    if (call) this.track(name, call);
  }

  private track(name: string, call: MediaConnection) {
    this.hangUp(name);
    const r: Remote = { name, call, level: 0 };
    this.remotes.set(name, r);
    call.on('stream', (stream) => {
      const ctx = this.ctx;
      if (!ctx || this.remotes.get(name) !== r) return;
      r.el?.remove();
      const el = new Audio();
      el.muted = true;
      el.srcObject = stream;
      void el.play().catch(() => undefined);
      r.el = el;
      const src = ctx.createMediaStreamSource(stream);
      r.gain = ctx.createGain();
      r.analyser = ctx.createAnalyser();
      r.analyser.fftSize = 512;
      src.connect(r.analyser);
      src.connect(r.gain).connect(ctx.destination);
    });
    const gone = () => {
      if (this.remotes.get(name) === r) this.hangUp(name);
    };
    call.on('close', gone);
    call.on('error', gone);
  }

  private hangUp(name: string) {
    const r = this.remotes.get(name);
    if (!r) return;
    this.remotes.delete(name);
    r.gain?.disconnect();
    r.analyser?.disconnect();
    if (r.el) {
      r.el.srcObject = null;
      r.el.remove();
    }
    try {
      r.call.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Every frame: whether you're sending (push-to-talk held, or loud enough), each voice's volume
   * (`distance` to that player for proximity; null when they aren't in the game you see), and
   * who is talking.
   */
  update(dt: number, s: VoiceSettings, pttHeld: boolean, distance: (name: string) => number | null): { you: boolean; talking: string[] } {
    if (this.state !== 'on' || !this.ctx) return { you: false, talking: [] };
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.micGain) this.micGain.gain.value = s.micGain;
    const loud = this.micAnalyser ? levelOf(this.micAnalyser, this.buf) : 0;
    let send = false;
    if (s.mode === 'ptt') send = pttHeld;
    else if (s.mode === 'voice') {
      if (loud * s.micGain > s.threshold * 0.25) this.hold = 0.35;
      else this.hold = Math.max(0, this.hold - dt);
      send = this.hold > 0;
    }
    if (send !== this.transmitting) {
      this.transmitting = send;
      for (const t of this.outStream?.getAudioTracks() ?? []) t.enabled = send;
    }
    const talking: string[] = [];
    for (const r of this.remotes.values()) {
      if (!r.gain || !r.analyser) continue;
      let v = s.volume;
      if (s.proximity) {
        const d = distance(r.name);
        if (d !== null) v *= Math.max(0, 1 - d / Math.max(1, s.range));
      }
      r.gain.gain.value = v;
      r.level = levelOf(r.analyser, this.buf);
      if (r.level > 0.02 && v > 0.01) talking.push(r.name);
    }
    return { you: send, talking };
  }

  /** How many people you're connected to by voice. */
  get connections(): number {
    let n = 0;
    for (const r of this.remotes.values()) if (r.gain) n++;
    return n;
  }

  /** A new room: nobody known yet. */
  forget() {
    this.known.clear();
  }

  stop() {
    this.generation++;
    for (const name of [...this.remotes.keys()]) this.hangUp(name);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.outStream = null;
    this.micGain = null;
    this.micAnalyser = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.peer?.destroy();
    this.peer = null;
    this.id = '';
    this.transmitting = false;
    this.state = 'off';
  }
}

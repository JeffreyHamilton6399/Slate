/**
 * Server-relayed voice client.
 *
 * Instead of WebRTC P2P (which silently fails on strict NATs without a paid
 * TURN relay), audio rides the same WSS the app already uses: mic frames are
 * captured with an AudioWorklet, downsampled to 16 kHz mono, µ-law encoded
 * (~128 kbps) and sent to /voice; the server broadcasts each frame to the
 * rest of the room, where it's decoded and scheduled through WebAudio.
 *
 * Works on any network the app itself works on. Latency is a beat higher
 * than P2P (~150-300 ms) — fine for collab chatter.
 *
 * The client is intentionally optional: voice is opt-in via the toolbar.
 * When disabled, no mic permission is requested and no WS is opened.
 */

import { ensureIdentity } from '../sync/identity';
import { wsUrl } from '../sync/serverUrl';

interface VoiceClientOpts {
  room: string;
  onPeerLevel: (peerId: string, level: number) => void;
  onSelfLevel: (level: number) => void;
  onPeerJoin: (peerId: string, name: string) => void;
  onPeerLeave: (peerId: string) => void;
  /** Fired once when the connection ends for any reason (incl. socket drop). */
  onClosed: () => void;
}

const TARGET_RATE = 16_000;
/** Playback scheduling headroom — the jitter buffer. */
const JITTER_S = 0.08;
/** Max scheduled-ahead audio per peer. After a network stall the burst of
 *  late frames would otherwise queue further and further ahead, permanently
 *  adding delay; past this we drop frames until latency drains back down. */
const MAX_BACKLOG_S = 0.35;
/** Peer level decays to 0 when no frames arrive for this long. */
const SILENCE_MS = 350;

// ── G.711 µ-law ──────────────────────────────────────────────────────────────
const MU_CLIP = 32_635;
const MU_BIAS = 0x84;

function encodeMulaw(sample: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, sample)) * 32_767);
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > MU_CLIP) s = MU_CLIP;
  s += MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    /* find segment */
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeMulaw(byte: number): number {
  const b = ~byte & 0xff;
  const sign = b & 0x80;
  const exponent = (b >> 4) & 7;
  const mantissa = b & 0x0f;
  let s = ((mantissa << 3) + MU_BIAS) << exponent;
  s -= MU_BIAS;
  return (sign ? -s : s) / 32_768;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = (input.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** Static worklet module (public/voice-capture-worklet.js) — the CSP's
 *  script-src 'self' forbids blob: modules, so it ships as a real file. */
const CAPTURE_WORKLET_URL = '/voice-capture-worklet.js';

interface PeerPlayback {
  nextTime: number;
  lastFrameAt: number;
  gain?: GainNode;
}

export class VoiceClient {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private ac: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private peers = new Map<string, PeerPlayback>();
  private opts: VoiceClientOpts;
  private myId: string | null = null;
  private muted = false;
  private silenceTimer = 0;
  private closed = false;
  private textDecoder = new TextDecoder();
  /** Master output gain (everyone you hear) + requested per-peer levels. */
  private masterGain: GainNode | null = null;
  private outputVolume = 1;
  private peerVolumes = new Map<string, number>();

  constructor(opts: VoiceClientOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    try {
      await this.doConnect();
    } catch (e) {
      // Failure part-way through setup (worklet load, socket refused) must
      // release the mic + AudioContext — otherwise the browser's recording
      // indicator stays on with no voice session behind it.
      this.disconnect();
      throw e;
    }
  }

  private async doConnect(): Promise<void> {
    const identity = await ensureIdentity();
    this.myId = identity.peerId;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.stream = stream;

    const ac = new AudioContext();
    await ac.resume();
    this.ac = ac;
    this.masterGain = ac.createGain();
    this.masterGain.gain.value = this.outputVolume;
    this.masterGain.connect(ac.destination);
    await ac.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    this.sourceNode = ac.createMediaStreamSource(stream);
    this.captureNode = new AudioWorkletNode(ac, 'slate-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.sourceNode.connect(this.captureNode);
    this.captureNode.port.onmessage = (e) => this.onCaptured(e.data as Float32Array);

    const url = new URL(wsUrl('/voice'));
    url.searchParams.set('token', identity.token);
    url.searchParams.set('room', this.opts.room);
    const ws = new WebSocket(url.toString());
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(e.data);
      else this.onAudioFrame(e.data as ArrayBuffer);
    };
    ws.onclose = () => this.disconnect();

    // Decay speaking indicators for peers that stopped sending.
    this.silenceTimer = window.setInterval(() => {
      const now = Date.now();
      for (const [id, p] of this.peers) {
        if (now - p.lastFrameAt > SILENCE_MS) this.opts.onPeerLevel(id, 0);
      }
    }, 200);

    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('voice connection failed'));
    });
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.silenceTimer);
    if (this.socket) {
      try {
        this.socket.onclose = null;
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    for (const id of this.peers.keys()) this.opts.onPeerLeave(id);
    this.peers.clear();
    this.captureNode?.disconnect();
    this.captureNode = null;
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ac) {
      void this.ac.close();
      this.ac = null;
    }
    this.opts.onSelfLevel(0);
    this.opts.onClosed();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) t.enabled = !muted;
    }
  }

  /** Output volume for everyone you hear (0–1). */
  setOutputVolume(v: number): void {
    this.outputVolume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.outputVolume;
  }

  /** Per-person volume (0–2; 1 = normal). */
  setPeerVolume(peerId: string, v: number): void {
    const vol = Math.max(0, Math.min(2, v));
    this.peerVolumes.set(peerId, vol);
    const entry = this.peers.get(peerId);
    if (entry?.gain) entry.gain.gain.value = vol;
  }

  isMuted(): boolean {
    return this.muted;
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private onCaptured(frame: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    const rms = Math.sqrt(sum / frame.length);
    this.opts.onSelfLevel(this.muted ? 0 : Math.min(1, rms * 4));
    if (this.muted) return;
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ac) return;
    const ds = resampleLinear(frame, this.ac.sampleRate, TARGET_RATE);
    const bytes = new Uint8Array(ds.length);
    for (let i = 0; i < ds.length; i++) bytes[i] = encodeMulaw(ds[i]!);
    ws.send(bytes);
  }

  private onAudioFrame(data: ArrayBuffer): void {
    const ac = this.ac;
    if (!ac) return;
    const view = new Uint8Array(data);
    if (view.length < 2) return;
    const idLen = view[0]!;
    if (view.length <= 1 + idLen) return;
    const peerId = this.textDecoder.decode(view.subarray(1, 1 + idLen));
    const payload = view.subarray(1 + idLen);

    const samples = new Float32Array(payload.length);
    let sum = 0;
    for (let i = 0; i < payload.length; i++) {
      const v = decodeMulaw(payload[i]!);
      samples[i] = v;
      sum += v * v;
    }
    this.opts.onPeerLevel(peerId, Math.min(1, Math.sqrt(sum / payload.length) * 4));

    const buffer = ac.createBuffer(1, samples.length, TARGET_RATE);
    buffer.copyToChannel(samples, 0);
    const entry = this.peers.get(peerId) ?? { nextTime: 0, lastFrameAt: 0 };
    entry.lastFrameAt = Date.now();
    if (entry.nextTime - ac.currentTime > MAX_BACKLOG_S) {
      // Latency crept past the cap — skip this frame; playback keeps draining
      // in real time, so the queue shrinks back toward the jitter target.
      this.peers.set(peerId, entry);
      return;
    }
    // Route: source (→ gap fade) → per-peer gain → master gain → speakers.
    if (!entry.gain) {
      entry.gain = ac.createGain();
      entry.gain.gain.value = this.peerVolumes.get(peerId) ?? 1;
      entry.gain.connect(this.masterGain ?? ac.destination);
    }
    const startAt = Math.max(ac.currentTime + JITTER_S, entry.nextTime);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    if (entry.nextTime > 0 && startAt > entry.nextTime + 0.001) {
      // Resuming after a gap — a 5 ms fade-in avoids the pop of a raw
      // waveform edge landing mid-cycle.
      const g = ac.createGain();
      g.gain.setValueAtTime(0, startAt);
      g.gain.linearRampToValueAtTime(1, startAt + 0.005);
      src.connect(g);
      g.connect(entry.gain);
    } else {
      src.connect(entry.gain);
    }
    src.start(startAt);
    entry.nextTime = startAt + buffer.duration;
    this.peers.set(peerId, entry);
  }

  private onJson(raw: string): void {
    interface PresenceMsg {
      type: string;
      from?: string;
      name?: string;
    }
    let msg: PresenceMsg | null = null;
    try {
      msg = JSON.parse(raw) as PresenceMsg;
    } catch {
      return;
    }
    if (!msg || !msg.type) return;
    const from = msg.from ?? '';
    if (from === this.myId) return;
    if (msg.type === 'hello' && from) {
      if (!this.peers.has(from)) this.peers.set(from, { nextTime: 0, lastFrameAt: 0 });
      this.opts.onPeerJoin(from, msg.name ?? 'Guest');
    } else if (msg.type === 'bye' && from) {
      this.peers.delete(from);
      this.opts.onPeerLeave(from);
    }
    // offer/answer/ice from older clients are ignored — transport is relayed.
  }
}

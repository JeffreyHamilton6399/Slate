/**
 * WebRTC voice client.
 *
 * Each peer in a room opens a WebSocket to /voice (server: voice.ts) which
 * announces the peer and relays SDP / ICE messages. We use simple-peer for
 * per-peer audio-only RTC connections. Local mic + remote audio playback
 * are handled here; a rolling RMS computes a voiceLevel for UI activity.
 *
 * The client is intentionally optional: voice is opt-in via the toolbar.
 * When disabled, no mic permission is requested and no WS is opened.
 */

import SimplePeer from 'simple-peer';
import { ensureIdentity } from '../sync/identity';

interface VoiceClientOpts {
  room: string;
  onPeerLevel: (peerId: string, level: number) => void;
  onSelfLevel: (level: number) => void;
  onPeerJoin: (peerId: string, name: string) => void;
  onPeerLeave: (peerId: string) => void;
}

interface PeerEntry {
  peer: SimplePeer.Instance;
  name: string;
  audio: HTMLAudioElement;
  analyser?: AnalyserNode;
}

interface IceConfig {
  iceServers: RTCIceServer[];
}

export class VoiceClient {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private peers = new Map<string, PeerEntry>();
  private opts: VoiceClientOpts;
  private myId: string | null = null;
  private analyser: AnalyserNode | null = null;
  private ac: AudioContext | null = null;
  private rafHandle = 0;
  private iceConfig: IceConfig | null = null;
  private muted = false;

  constructor(opts: VoiceClientOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const identity = await ensureIdentity();
    this.myId = identity.peerId;
    // Fetch TURN config — never block on it.
    void fetch('/api/turn')
      .then((r) => r.json())
      .then((j) => (this.iceConfig = j as IceConfig))
      .catch(() => undefined);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.stream = stream;
    this.setupAnalyser(stream);
    const url = new URL('/voice', location.origin);
    url.searchParams.set('token', identity.token);
    url.searchParams.set('room', this.opts.room);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url.toString());
    this.socket = ws;
    ws.onmessage = (e) => this.onMessage(e);
    ws.onclose = () => this.disconnect();
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('voice ws error'));
    });
  }

  disconnect(): void {
    cancelAnimationFrame(this.rafHandle);
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    for (const entry of this.peers.values()) {
      try {
        entry.peer.destroy();
      } catch {
        /* ignore */
      }
      entry.audio.srcObject = null;
      this.opts.onPeerLeave(entry.audio.dataset.peerId ?? '');
    }
    this.peers.clear();
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ac) {
      void this.ac.close();
      this.ac = null;
      this.analyser = null;
    }
    this.opts.onSelfLevel(0);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.stream) return;
    for (const t of this.stream.getAudioTracks()) t.enabled = !muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private setupAnalyser(stream: MediaStream): void {
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    this.ac = ac;
    this.analyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      this.rafHandle = requestAnimationFrame(loop);
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      this.opts.onSelfLevel(this.muted ? 0 : Math.min(1, rms * 4));
    };
    loop();
  }

  private onMessage(e: MessageEvent<string>): void {
    let msg: { type: string; from?: string; name?: string; payload?: unknown } | null = null;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || !msg.type) return;
    const from = msg.from ?? '';
    if (msg.type === 'hello' && from) {
      this.openPeer(from, msg.name ?? 'Guest', /* initiator */ from > (this.myId ?? ''));
      this.opts.onPeerJoin(from, msg.name ?? 'Guest');
      return;
    }
    if (msg.type === 'bye' && from) {
      const e = this.peers.get(from);
      if (e) {
        try {
          e.peer.destroy();
        } catch {
          /* ignore */
        }
        this.peers.delete(from);
        this.opts.onPeerLeave(from);
      }
      return;
    }
    if ((msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') && from) {
      const entry = this.peers.get(from) ?? this.openPeer(from, 'Guest', false);
      entry.peer.signal(msg.payload as SimplePeer.SignalData);
    }
  }

  private openPeer(peerId: string, name: string, initiator: boolean): PeerEntry {
    if (this.peers.has(peerId)) return this.peers.get(peerId)!;
    const config = this.iceConfig ?? {
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    };
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: this.stream ?? undefined,
      config,
    });
    const audio = new Audio();
    audio.autoplay = true;
    audio.dataset.peerId = peerId;
    const entry: PeerEntry = { peer, name, audio };
    this.peers.set(peerId, entry);
    peer.on('signal', (data) => {
      const type =
        (data as { type?: string }).type === 'offer'
          ? 'offer'
          : (data as { type?: string }).type === 'answer'
            ? 'answer'
            : 'ice';
      this.send({ type, to: peerId, room: this.opts.room, payload: data });
    });
    peer.on('stream', (s: MediaStream) => {
      audio.srcObject = s;
      void audio.play().catch(() => undefined);
      this.attachPeerAnalyser(peerId, s);
    });
    peer.on('close', () => {
      this.peers.delete(peerId);
      audio.srcObject = null;
      this.opts.onPeerLeave(peerId);
    });
    peer.on('error', () => {
      this.peers.delete(peerId);
      audio.srcObject = null;
      this.opts.onPeerLeave(peerId);
    });
    return entry;
  }

  private attachPeerAnalyser(peerId: string, stream: MediaStream): void {
    const ac = this.ac;
    if (!ac) return;
    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.analyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      if (!this.peers.has(peerId)) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      this.opts.onPeerLevel(peerId, Math.min(1, rms * 4));
      requestAnimationFrame(loop);
    };
    loop();
  }

  private send(msg: { type: string; to: string; room: string; payload: unknown }): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify(msg));
  }
}

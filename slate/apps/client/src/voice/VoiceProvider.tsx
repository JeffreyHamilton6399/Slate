/**
 * Voice provider — manages a single VoiceClient instance per room.
 *
 * Voice is opt-in: clients connect only when the user clicks "Join voice".
 * Self level is reflected in awareness so other peers see who is speaking.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceClient } from './voiceClient';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { toast } from '../ui/Toast';

interface VoiceCtx {
  connected: boolean;
  muted: boolean;
  selfLevel: number;
  peerLevels: Map<string, number>;
  connect: () => Promise<void>;
  disconnect: () => void;
  setMuted: (m: boolean) => void;
  /** Volume of everyone you hear (0–1, persisted in Settings). */
  setOutputVolume: (v: number) => void;
  /** Volume of one person (0–2). */
  setPeerVolume: (peerId: string, v: number) => void;
}

const Ctx = createContext<VoiceCtx | null>(null);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const room = useRoom();
  const [connected, setConnected] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [selfLevel, setSelfLevel] = useState(0);
  const [peerLevels, setPeerLevels] = useState<Map<string, number>>(new Map());
  const clientRef = useRef<VoiceClient | null>(null);

  const intentionalLeaveRef = useRef(false);

  const connect = useCallback(async () => {
    if (clientRef.current) return;
    intentionalLeaveRef.current = false;
    // Levels arrive per audio frame (~23/s per speaker). Quantize to 0.1
    // steps and bail out on no-change so React state (and everything
    // subscribed to it) only updates on real speaking transitions.
    const quantize = (v: number) => Math.min(1, Math.round(v * 10) / 10);
    const client = new VoiceClient({
      room: room.room,
      onSelfLevel: (level) => {
        const q = quantize(level);
        setSelfLevel((prev) => (prev === q ? prev : q));
      },
      onPeerLevel: (id, level) =>
        setPeerLevels((cur) => {
          const q = quantize(level);
          if (cur.get(id) === q) return cur;
          const next = new Map(cur);
          next.set(id, q);
          return next;
        }),
      onPeerJoin: () => undefined,
      onPeerLeave: (id) =>
        setPeerLevels((cur) => {
          const next = new Map(cur);
          next.delete(id);
          return next;
        }),
      onClosed: () => {
        // The socket can die under us (server restart, network); reflect it
        // in the UI instead of showing a live mic that carries nothing.
        // A connect() that never succeeded (clientRef never set) surfaces its
        // own "Voice failed" toast — don't stack a "disconnected" one on top.
        const wasActive = clientRef.current !== null;
        clientRef.current = null;
        setConnected(false);
        setSelfLevel(0);
        setPeerLevels(new Map());
        if (wasActive && !intentionalLeaveRef.current) {
          toast({
            title: 'Voice disconnected',
            description: 'The voice connection dropped — tap Join voice to rejoin.',
            variant: 'error',
          });
        }
      },
    });
    try {
      await client.connect();
      client.setOutputVolume(useAppStore.getState().voiceVolume);
      clientRef.current = client;
      setConnected(true);
    } catch (e) {
      console.error('voice connect failed', e);
      toast({ title: 'Voice failed', description: (e as Error).message, variant: 'error' });
    }
  }, [room]);

  const disconnect = useCallback(() => {
    intentionalLeaveRef.current = true;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnected(false);
    setSelfLevel(0);
    setPeerLevels(new Map());
  }, []);

  const setMuted = useCallback((m: boolean) => {
    clientRef.current?.setMuted(m);
    setMutedState(m);
  }, []);

  const setOutputVolume = useCallback((v: number) => {
    useAppStore.getState().setVoiceVolume(v);
    clientRef.current?.setOutputVolume(v);
  }, []);

  const setPeerVolume = useCallback((peerId: string, v: number) => {
    clientRef.current?.setPeerVolume(peerId, v);
  }, []);

  // Tell the room whether we're in voice (drives the People widget).
  useEffect(() => {
    room.setLocalAwareness({ inVoice: connected });
  }, [connected, room]);

  // Reflect self level into awareness so others see the talking indicator.
  // Throttled: every awareness update is a sync-channel message and the
  // server rate-limits messages per peer.
  const lastAwarenessRef = useRef({ t: 0, v: -1 });
  useEffect(() => {
    const v = connected ? selfLevel : 0;
    const last = lastAwarenessRef.current;
    const now = Date.now();
    if (v === last.v) return;
    if (v !== 0 && now - last.t < 250) return;
    lastAwarenessRef.current = { t: now, v };
    room.setLocalAwareness({ voiceLevel: v });
  }, [connected, selfLevel, room]);

  useEffect(() => {
    return () => {
      intentionalLeaveRef.current = true;
      clientRef.current?.disconnect();
    };
  }, []);

  const value = useMemo<VoiceCtx>(
    () => ({
      connected,
      muted,
      selfLevel,
      peerLevels,
      connect,
      disconnect,
      setMuted,
      setOutputVolume,
      setPeerVolume,
    }),
    [connected, muted, selfLevel, peerLevels, connect, disconnect, setMuted, setOutputVolume, setPeerVolume],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVoice(): VoiceCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVoice must be used inside VoiceProvider');
  return v;
}

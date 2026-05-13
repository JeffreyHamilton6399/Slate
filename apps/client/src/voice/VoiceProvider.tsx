/**
 * Voice provider — manages a single VoiceClient instance per room.
 *
 * Voice is opt-in: clients connect only when the user clicks "Join voice".
 * Self level is reflected in awareness so other peers see who is speaking.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceClient } from './voiceClient';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';

interface VoiceCtx {
  connected: boolean;
  muted: boolean;
  selfLevel: number;
  peerLevels: Map<string, number>;
  connect: () => Promise<void>;
  disconnect: () => void;
  setMuted: (m: boolean) => void;
}

const Ctx = createContext<VoiceCtx | null>(null);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const room = useRoom();
  const [connected, setConnected] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [selfLevel, setSelfLevel] = useState(0);
  const [peerLevels, setPeerLevels] = useState<Map<string, number>>(new Map());
  const clientRef = useRef<VoiceClient | null>(null);

  const connect = useCallback(async () => {
    if (clientRef.current) return;
    const client = new VoiceClient({
      room: room.room,
      onSelfLevel: setSelfLevel,
      onPeerLevel: (id, level) =>
        setPeerLevels((cur) => {
          const next = new Map(cur);
          next.set(id, level);
          return next;
        }),
      onPeerJoin: () => undefined,
      onPeerLeave: (id) =>
        setPeerLevels((cur) => {
          const next = new Map(cur);
          next.delete(id);
          return next;
        }),
    });
    try {
      await client.connect();
      clientRef.current = client;
      setConnected(true);
    } catch (e) {
      toast({ title: 'Voice failed', description: (e as Error).message, variant: 'error' });
    }
  }, [room]);

  const disconnect = useCallback(() => {
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

  // Reflect self level into awareness so others see talking indicator.
  useEffect(() => {
    if (!connected) {
      room.setLocalAwareness({ voiceLevel: 0 });
      return;
    }
    room.setLocalAwareness({ voiceLevel: selfLevel });
  }, [connected, selfLevel, room]);

  useEffect(() => {
    return () => clientRef.current?.disconnect();
  }, []);

  const value = useMemo<VoiceCtx>(
    () => ({ connected, muted, selfLevel, peerLevels, connect, disconnect, setMuted }),
    [connected, muted, selfLevel, peerLevels, connect, disconnect, setMuted],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVoice(): VoiceCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVoice must be used inside VoiceProvider');
  return v;
}

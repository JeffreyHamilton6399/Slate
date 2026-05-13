/**
 * React hook wrapping a SlateRoom: lazily opens on mount, exposes status +
 * awareness, and tears down on unmount.
 */
import { useEffect, useState } from 'react';
import type { AwarenessState } from '@slate/sync-protocol';
import { SlateRoom, type ConnectionStatus } from './provider.js';

export interface UseSlateRoomResult {
  room: SlateRoom | null;
  status: ConnectionStatus;
  awareness: AwarenessState[];
  error: Error | null;
}

export function useSlateRoom(roomName: string | null, displayName?: string): UseSlateRoomResult {
  const [room, setRoom] = useState<SlateRoom | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [awareness, setAwareness] = useState<AwarenessState[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!roomName) {
      setRoom(null);
      return;
    }
    let cancelled = false;
    let opened: SlateRoom | null = null;

    SlateRoom.open({ room: roomName, ...(displayName !== undefined ? { displayName } : {}) })
      .then((r) => {
        if (cancelled) {
          r.dispose();
          return;
        }
        opened = r;
        setRoom(r);
        r.onStatusChange(setStatus);
        r.onAwarenessChange(setAwareness);
      })
      .catch((e) => {
        if (!cancelled) setError(e as Error);
      });

    return () => {
      cancelled = true;
      opened?.dispose();
      setRoom(null);
    };
  }, [roomName, displayName]);

  return { room, status, awareness, error };
}

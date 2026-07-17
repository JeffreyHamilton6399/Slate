/**
 * React hook wrapping a SlateRoom: lazily opens on mount, exposes status +
 * awareness, and tears down on unmount.
 *
 * Rooms are ref-counted in a module registry keyed by room name. Under React
 * 18 StrictMode (and any fast unmount→remount) the same board is requested
 * twice in a row; opening a second SlateRoom means two IndexeddbPersistence
 * instances race on the same IndexedDB database, and disposing the aborted one
 * can leave the surviving doc empty — the "blank on first reload, fine on the
 * second" bug. Sharing one ref-counted instance eliminates that race: the doc
 * is opened once and only disposed when the last consumer unmounts (after a
 * short grace period so a StrictMode remount reattaches instead of churning).
 */
import { useEffect, useRef, useState } from 'react';
import type { AwarenessState } from '@slate/sync-protocol';
import { SlateRoom, type ConnectionStatus } from './provider.js';
import { registerSampleSyncMap } from '../audio/sampleStore';

export interface UseSlateRoomResult {
  room: SlateRoom | null;
  status: ConnectionStatus;
  awareness: AwarenessState[];
  error: Error | null;
}

interface RegistryEntry {
  promise: Promise<SlateRoom>;
  room: SlateRoom | null;
  refs: number;
  disposeTimer: number | null;
}

const registry = new Map<string, RegistryEntry>();
// How long to keep an unused room alive so a StrictMode remount can reattach.
const DISPOSE_GRACE_MS = 1_000;

function acquireRoom(roomName: string, displayName?: string): RegistryEntry {
  const entry = registry.get(roomName);
  if (entry) {
    if (entry.disposeTimer !== null) {
      clearTimeout(entry.disposeTimer);
      entry.disposeTimer = null;
    }
    entry.refs++;
    return entry;
  }
  const created: RegistryEntry = {
    refs: 1,
    room: null,
    disposeTimer: null,
    promise: SlateRoom.open({
      room: roomName,
      ...(displayName !== undefined ? { displayName } : {}),
    }),
  };
  created.promise.then((r) => {
    created.room = r;
    // Nobody is holding this room anymore (all consumers unmounted before it
    // finished opening) — dispose it right away.
    if (created.refs <= 0 && registry.get(roomName) === created) {
      registry.delete(roomName);
      r.dispose();
    }
  });
  registry.set(roomName, created);
  return created;
}

function releaseRoom(roomName: string, entry: RegistryEntry): void {
  entry.refs--;
  if (entry.refs > 0) return;
  // Grace period: a StrictMode remount (or quick navigation back) reattaches
  // before this fires and cancels it.
  entry.disposeTimer = window.setTimeout(() => {
    if (entry.refs > 0) return;
    if (registry.get(roomName) === entry) registry.delete(roomName);
    entry.room?.dispose();
  }, DISPOSE_GRACE_MS);
}

export function useSlateRoom(roomName: string | null, displayName?: string): UseSlateRoomResult {
  const [room, setRoom] = useState<SlateRoom | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [awareness, setAwareness] = useState<AwarenessState[]>([]);
  const [error, setError] = useState<Error | null>(null);

  // The name at open time; kept in a ref so a name change never re-opens the
  // whole room (that churned the connection and lost live state).
  const nameRef = useRef(displayName);
  nameRef.current = displayName;

  useEffect(() => {
    if (!roomName) {
      setRoom(null);
      return;
    }
    let cancelled = false;
    const entry = acquireRoom(roomName, nameRef.current);

    // Attach synchronously if the room is already open (reused instance),
    // otherwise when the open promise resolves. Keep the unsubscribers — the
    // room instance is shared and may outlive this consumer, so listeners left
    // behind would accumulate across remounts and keep firing setState on an
    // unmounted component.
    const unsubs: Array<() => void> = [];
    const attach = (r: SlateRoom) => {
      if (cancelled) return;
      setRoom(r);
      unsubs.push(r.onStatusChange(setStatus));
      unsubs.push(r.onAwarenessChange(setAwareness));
      // Register the multiplayer audio sample-sync map as soon as the room
      // resolves — NOT from the AudioEditor mount. Previously this only ran
      // when the AudioEditor mounted, so a peer on a 2D/3D board (with the
      // audio panel closed) never registered the sync map and never received
      // remote sample blobs. When they later opened the audio panel, the
      // initial scan caught up, but there was a window where clips were
      // silent. Registering here ensures the Y.Map observer + initial scan
      // run for every peer the moment the room opens, regardless of which
      // editor mode is active. Idempotent — `registerSampleSyncMap` no-ops
      // if `room` is the same instance it was last called with.
      registerSampleSyncMap(r);
    };
    if (entry.room) attach(entry.room);
    else entry.promise.then(attach).catch((e) => !cancelled && setError(e as Error));

    return () => {
      cancelled = true;
      for (const off of unsubs) off();
      setRoom(null);
      releaseRoom(roomName, entry);
    };
  }, [roomName]);

  // Live-rename in the roster when the display name changes — no reconnect.
  useEffect(() => {
    if (room && displayName) room.renameMe(displayName);
  }, [room, displayName]);

  return { room, status, awareness, error };
}

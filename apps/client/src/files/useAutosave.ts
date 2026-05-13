/**
 * Auto-save — periodically persists a labeled snapshot to localStorage so
 * the user always has a few recoverable points. y-indexeddb handles the
 * fine-grained live persistence; this is a coarser "last hour" history.
 */

import { useEffect, useRef, useState } from 'react';
import type { SlateRoom } from '../sync/provider';
import { persistSave, snapshotDoc } from './snapshot';

const INTERVAL_MS = 60_000; // every minute
const IDLE_DEBOUNCE_MS = 5_000;

interface AutosaveState {
  /** Last autosave timestamp (ms epoch). null = never. */
  savedAt: number | null;
  /** Whether a save is queued (recent edit). */
  dirty: boolean;
}

export function useAutosave(room: SlateRoom | null): AutosaveState {
  const [state, setState] = useState<AutosaveState>({ savedAt: null, dirty: false });
  const idleTimer = useRef<number | null>(null);
  const intervalTimer = useRef<number | null>(null);
  const lastSavedRef = useRef<number>(0);

  useEffect(() => {
    if (!room) return;
    const doSave = () => {
      try {
        const snap = snapshotDoc(room);
        persistSave(snap, `autosave • ${new Date().toLocaleString()}`);
        const t = Date.now();
        lastSavedRef.current = t;
        setState({ savedAt: t, dirty: false });
      } catch {
        /* save failures are non-fatal */
      }
    };

    const scheduleIdleSave = () => {
      setState((s) => ({ ...s, dirty: true }));
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        doSave();
      }, IDLE_DEBOUNCE_MS);
    };

    const sub = () => scheduleIdleSave();

    room.slate.doc.on('update', sub);
    // Periodic guaranteed save even without idle.
    intervalTimer.current = window.setInterval(() => {
      if (Date.now() - lastSavedRef.current >= INTERVAL_MS) doSave();
    }, INTERVAL_MS);

    return () => {
      room.slate.doc.off('update', sub);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (intervalTimer.current) clearInterval(intervalTimer.current);
    };
  }, [room]);

  return state;
}

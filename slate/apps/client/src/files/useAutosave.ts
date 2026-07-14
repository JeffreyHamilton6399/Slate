/**
 * Auto-save — keeps ONE rolling autosave slot per board up to date (Google
 * Drive style: the previous autosave is overwritten, no timestamped pile).
 * y-indexeddb handles fine-grained live persistence; this is the coarse
 * recoverable copy. On tab close a final save runs synchronously; the
 * browser's "unsaved changes" prompt only appears if that save fails.
 */

import { useEffect, useRef, useState } from 'react';
import type { SlateRoom } from '../sync/provider';
import { autosaveSlotId, persistSave, pruneLegacyAutosaves, snapshotDoc } from './snapshot';

const INTERVAL_MS = 60_000; // every minute
// Short enough that a pause in editing saves (and the badge flips to "Saved")
// almost immediately, so it's obvious saving is actually happening.
const IDLE_DEBOUNCE_MS = 1_200;

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

  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!room) return;
    // Old builds piled up one save per minute — clear that backlog once.
    pruneLegacyAutosaves(room.room);

    const doSave = () => {
      try {
        const snap = snapshotDoc(room);
        persistSave(snap, `Autosave — ${snap.boardName}`, autosaveSlotId(snap.boardName));
        const t = Date.now();
        lastSavedRef.current = t;
        dirtyRef.current = false;
        setState({ savedAt: t, dirty: false });
        return true;
      } catch {
        return false; // save failures are non-fatal (quota etc.)
      }
    };

    const scheduleIdleSave = () => {
      dirtyRef.current = true;
      setState((s) => ({ ...s, dirty: true }));
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        doSave();
      }, IDLE_DEBOUNCE_MS);
    };

    // Only LOCAL edits should mark the board dirty. Remote sync, the initial
    // IndexedDB hydration, and reconnect re-syncs all fire 'update' too; if we
    // reacted to those, any connection wobble would keep the badge stuck on
    // "Saving…" forever (and never actually settle). Yjs tags each update with
    // its origin — the provider for remote, the IndexeddbPersistence for loads.
    const sub = (_update: Uint8Array, origin: unknown) => {
      if (origin === room.provider || origin === room.idb) return;
      scheduleIdleSave();
    };

    room.slate.doc.on('update', sub);
    // Periodic guaranteed save even without idle.
    intervalTimer.current = window.setInterval(() => {
      if (Date.now() - lastSavedRef.current >= INTERVAL_MS) doSave();
    }, INTERVAL_MS);

    // Closing the tab with fresh edits: run the save right now (localStorage
    // is synchronous, so it completes before unload). Only if that fails do
    // we ask the browser to show the unsaved-changes prompt.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      if (!doSave()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      room.slate.doc.off('update', sub);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (intervalTimer.current) clearInterval(intervalTimer.current);
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Leaving the board inside the app: flush pending edits too.
      if (dirtyRef.current) doSave();
    };
  }, [room]);

  return state;
}

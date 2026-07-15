/**
 * Cross-device save backup — mirrors the local save slots (manual, autosave,
 * Save-as copies) into a per-user Supabase table. Backup pushes every local
 * save; restore pulls the user's cloud saves into local storage, where the
 * normal Open dialog picks them up.
 */

import {
  listSaves,
  loadSave,
  onDeleteSave,
  persistSave,
  onSavePersisted,
  type SavedSnapshot,
} from '../files/snapshot';
import { supabase } from './supabase';

export interface CloudSyncResult {
  pushed?: number;
  pulled?: number;
  error?: string;
}

export async function backupSavesToCloud(userId: string): Promise<CloudSyncResult> {
  if (!supabase) return { error: 'Accounts are not configured.' };
  const entries = listSaves();
  const rows = entries
    .map((e) => ({ entry: e, snap: loadSave(e.id) }))
    .filter((x): x is { entry: (typeof entries)[number]; snap: SavedSnapshot } => x.snap !== null)
    .map(({ entry, snap }) => ({
      user_id: userId,
      save_id: entry.id,
      board_name: entry.boardName,
      label: entry.label,
      mode: entry.mode,
      saved_at: new Date(entry.savedAt).toISOString(),
      data: snap,
    }));
  if (rows.length === 0) return { pushed: 0 };
  const { error } = await supabase.from('board_saves').upsert(rows, { onConflict: 'user_id,save_id' });
  if (error) return { error: error.message };
  return { pushed: rows.length };
}

/**
 * While signed in, mirror every save write to the cloud automatically
 * (debounced per save id so autosave bursts collapse into one upsert).
 * Also mirrors local deletions to Supabase so deleted projects don't get
 * pulled back on next restore. Returns an unsubscribe function.
 */
export function startCloudSaveBridge(userId: string): () => void {
  const timers = new Map<string, number>();
  const stop = onSavePersisted((entry, snap) => {
    const prev = timers.get(entry.id);
    if (prev) clearTimeout(prev);
    timers.set(
      entry.id,
      window.setTimeout(() => {
        timers.delete(entry.id);
        void supabase
          ?.from('board_saves')
          .upsert(
            {
              user_id: userId,
              save_id: entry.id,
              board_name: entry.boardName,
              label: entry.label,
              mode: entry.mode,
              saved_at: new Date(entry.savedAt).toISOString(),
              data: snap,
            },
            { onConflict: 'user_id,save_id' },
          )
          .then(({ error }) => {
            if (error) console.warn('cloud save sync failed:', error.message);
          });
      }, 4000),
    );
  });
  const stopDelete = onDeleteSave((saveId) => {
    void deleteCloudSave(userId, saveId);
  });
  return () => {
    stop();
    stopDelete();
    for (const t of timers.values()) clearTimeout(t);
  };
}

/** Delete a single save row from the user's cloud backup. */
export async function deleteCloudSave(userId: string, saveId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('board_saves')
    .delete()
    .eq('user_id', userId)
    .eq('save_id', saveId);
  if (error) console.warn('cloud save delete failed:', error.message);
}

/** Delete every cloud save row for a board name (used when a user removes the
 *  project from the Home recents grid — all autosave/manual/Save-as slots). */
export async function deleteCloudSavesByBoard(userId: string, boardName: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('board_saves')
    .delete()
    .eq('user_id', userId)
    .eq('board_name', boardName);
  if (error) console.warn('cloud save delete-by-board failed:', error.message);
}

export async function restoreSavesFromCloud(userId: string): Promise<CloudSyncResult> {
  if (!supabase) return { error: 'Accounts are not configured.' };
  const { data, error } = await supabase
    .from('board_saves')
    .select('save_id,label,data')
    .eq('user_id', userId)
    .order('saved_at', { ascending: false })
    .limit(50);
  if (error) return { error: error.message };
  let pulled = 0;
  for (const row of data ?? []) {
    const snap = row.data as SavedSnapshot;
    if (!snap || snap.schema !== 'slate-v2') continue;
    persistSave(snap, row.label as string, row.save_id as string);
    pulled++;
  }
  return { pulled };
}

/**
 * IndexedDB audio sample store — keeps PCM data OUT of the Yjs document.
 *
 * A 3-minute song at 44100Hz stereo = ~16M numbers = ~127MB. Storing that in
 * Yjs makes every sync, every observeDeep, every IndexedDB persistence write
 * incredibly slow. Instead, we store samples as a Float32Array blob in a
 * separate IndexedDB database, and keep only a string key in the Yjs clip.
 *
 * The key is `clipId` — lookups are O(1) via IndexedDB's key path.
 *
 * MULTIPLAYER SYNC: For clips under the SYNC_SIZE_LIMIT (~5MB), samples are
 * also published to a Yjs Y.Map (base64-encoded) so other peers in the room
 * receive them automatically. Larger clips stay local-only (would freeze Yjs).
 */

import * as Y from 'yjs';

const DB_NAME = 'slate-audio-samples';
const STORE = 'samples';
let dbPromise: Promise<IDBDatabase> | null = null;

/** Maximum sample blob size (in bytes) to sync via Yjs. ~5MB = ~28s mono @ 44.1kHz. */
const SYNC_SIZE_LIMIT = 5_000_000;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// ── Multiplayer sample sync via Yjs ─────────────────────────────────────────
// A separate Y.Map on the same doc, keyed by sampleKey, holding base64 strings.
// Only used for clips under SYNC_SIZE_LIMIT. Listened to by all peers to
// auto-populate their local IndexedDB.

let syncMap: Y.Map<string> | null = null;
let syncRoom: { slate: { doc: Y.Doc } } | null = null;
const syncedKeys = new Set<string>();

/** Register the Yjs Y.Map used for sample sync. Call once per room. */
export function registerSampleSyncMap(room: { slate: { doc: Y.Doc } }): void {
  if (syncRoom === room) return;
  syncRoom = room;
  syncMap = room.slate.doc.getMap<string>('audioSampleSync');
  // Listen for remote sample additions.
  syncMap.observe((event) => {
    for (const key of event.keysChanged) {
      const base64 = syncMap!.get(key);
      if (base64 === undefined) {
        // Key was deleted (or never had a value). Drop it from syncedKeys so
        // a future re-add with the same key is processed, not skipped —
        // otherwise a delete+re-add cycle would leave peers with stale
        // (or no) samples for that key forever.
        syncedKeys.delete(key);
        continue;
      }
      if (syncedKeys.has(key)) continue;
      // Decode base64 → ArrayBuffer → Float32Array → store locally.
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const float32 = new Float32Array(bytes.buffer);
        syncedKeys.add(key);
        void storeSamples(key, float32);
        // Notify the AudioEditor that samples arrived.
        window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: key }));
      } catch {
        // ignore decode errors
      }
    }
  });
}

/** Check if a sampleKey has been synced (exists in the Yjs sync map). */
export function isSampleSynced(sampleKey: string): boolean {
  return syncedKeys.has(sampleKey);
}

/** Publish samples to the Yjs sync map so other peers receive them. */
function publishToSyncMap(key: string, float32: Float32Array): void {
  if (!syncMap || float32.byteLength > SYNC_SIZE_LIMIT) return;
  try {
    // Float32Array → ArrayBuffer → base64. The naive char-by-char string
    // concat is O(n²) (every `+=` rebuilds the whole string) and freezes the
    // main thread for several seconds on a 5MB blob. Build in 8KB chunks via
    // String.fromCharCode.apply — O(n) total, and 8192 is the safe stack
    // limit for Function.prototype.apply across JS engines.
    const bytes = new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);
    const CHUNK = 8192;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const end = Math.min(bytes.length, i + CHUNK);
      parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, end))));
    }
    const base64 = btoa(parts.join(''));
    syncMap.set(key, base64);
    syncedKeys.add(key);
  } catch {
    // ignore — large clips just don't sync
  }
}

/** Store audio samples in IndexedDB. Accepts number[] or Float32Array. */
export async function storeSamples(key: string, samples: number[] | Float32Array): Promise<void> {
  const db = await openDB();
  // Convert to Float32Array for compactness if not already.
  const float32 = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const promise = new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(float32.buffer, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await promise;
  // After local store succeeds, publish to the Yjs sync map for other peers.
  publishToSyncMap(key, float32);
}

/** Load audio samples from IndexedDB by key. Returns Float32Array. */
export async function loadSamples(key: string): Promise<Float32Array> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const buffer = req.result as ArrayBuffer | undefined;
      if (!buffer) { resolve(new Float32Array(0)); return; }
      resolve(new Float32Array(buffer));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete samples for a key (when a clip is deleted). */
export async function deleteSamples(key: string): Promise<void> {
  const db = await openDB();
  const promise = new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await promise;
  // Also remove from the Yjs sync map.
  if (syncMap && syncMap.has(key)) syncMap.delete(key);
  syncedKeys.delete(key);
}

/** Convert Float32Array back to number[] (only when needed for processing). */
export function float32ToNumberArray(f32: Float32Array): number[] {
  return Array.from(f32);
}

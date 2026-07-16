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

/** Maximum sample blob size (raw Float32 bytes) to sync via Yjs.
 *  24MB ≈ 2.2min mono / 1.1min stereo @ 44.1kHz — sent over the wire as int16
 *  (half the bytes) in bounded chunks. The old 5MB cap silently skipped
 *  anything past ~14s of stereo, which read as "other users can't hear my
 *  audio" for any real song. Clips beyond the cap still get a visible warning
 *  (slate:audio-sync-skipped) instead of failing silently. */
const SYNC_SIZE_LIMIT = 24_000_000;

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
//
// CHUNKED WIRE FORMAT: the relay drops any single Yjs update above
// MAX_UPDATE_BYTES, and a 5MB sample is ~6.7MB of base64 — publishing it as
// one Y.Map entry didn't just fail, it KILLED the uploader's connection on
// every subsequent sync attempt (the doc still contained the giant entry), so
// audio never reached other peers and the connection flapped forever. Large
// samples are therefore split into ~512KB base64 chunks, each committed in its
// OWN transaction (one small update per chunk):
//   `${key}#${i}`  → base64 chunk i
//   `${key}#meta`  → chunk count, written LAST — same-client updates arrive in
//                    order, so when a peer sees the meta every chunk is there.
// Samples that fit in one chunk keep the legacy plain `key` entry.

/** Base64 chars per chunk entry — keeps each Yjs update far below the relay's
 *  MAX_UPDATE_BYTES cap even on old servers still enforcing 1MB. */
const CHUNK_CHARS = 512_000;

let syncMap: Y.Map<string> | null = null;
let syncObserver: ((event: Y.YMapEvent<string>) => void) | null = null;
let syncRoom: { slate: { doc: Y.Doc } } | null = null;
const syncedKeys = new Set<string>();

/** sampleKey for a map entry name: strips the `#meta` / `#<n>` chunk suffix. */
function baseKeyOf(entry: string): string {
  const hash = entry.lastIndexOf('#');
  return hash === -1 ? entry : entry.slice(0, hash);
}

/** Register the Yjs Y.Map used for sample sync. Call once per room. */
export function registerSampleSyncMap(room: { slate: { doc: Y.Doc } }): void {
  if (syncRoom === room) return;
  // Switching rooms: detach from the previous doc's map and forget its keys —
  // a lingering observer on a disposed doc and stale syncedKeys entries would
  // make the new room skip samples it never actually received.
  if (syncMap && syncObserver) syncMap.unobserve(syncObserver);
  syncedKeys.clear();
  syncRoom = room;
  syncMap = room.slate.doc.getMap<string>('audioSampleSync');
  syncObserver = (event) => {
    for (const entry of event.keysChanged) {
      if (syncMap!.get(entry) === undefined) {
        // Entry deleted — drop the base key from syncedKeys so a future
        // re-add with the same key is processed, not skipped.
        syncedKeys.delete(baseKeyOf(entry));
        continue;
      }
      tryImportEntry(entry);
    }
  };
  syncMap.observe(syncObserver);
  // Import anything ALREADY in the map. The AudioEditor (which registers this)
  // often mounts after the initial doc sync applied the entries, so without
  // this scan a peer opening the audio panel late would never receive samples
  // published before it mounted.
  for (const entry of syncMap.keys()) tryImportEntry(entry);
}

/** Import the sample a map entry belongs to, if complete and not yet stored.
 *  Handles both the plain legacy format and the chunked format. */
function tryImportEntry(entry: string): void {
  if (!syncMap) return;
  const key = baseKeyOf(entry);
  if (syncedKeys.has(key)) return;
  let base64: string;
  let encoding: 'f32' | 'i16' = 'f32';
  const plain = syncMap.get(key);
  if (plain !== undefined) {
    base64 = plain; // plain entries are always float32 (legacy format)
  } else {
    // Chunked: need the meta (chunk count) plus every chunk present. Meta is
    // either "12" (older float32 chunks) or "12:i16" (int16-encoded).
    const metaRaw = syncMap.get(`${key}#meta`);
    if (metaRaw === undefined) return;
    const [countStr, enc] = metaRaw.split(':');
    const count = Number(countStr);
    if (!Number.isInteger(count) || count <= 0) return;
    if (enc === 'i16') encoding = 'i16';
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const c = syncMap.get(`${key}#${i}`);
      if (c === undefined) return; // still in flight — retry on next change
      parts.push(c);
    }
    base64 = parts.join('');
  }
  // Decode base64 → bytes → Float32Array → store locally. Store WITHOUT
  // publishing: re-publishing what we just received would make every peer
  // rebroadcast the full blob back into the doc.
  try {
    const binary = atob(base64);
    const stride = encoding === 'i16' ? 2 : 4;
    if (binary.length === 0 || binary.length % stride !== 0) return;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    let float32: Float32Array;
    if (encoding === 'i16') {
      const i16 = new Int16Array(bytes.buffer);
      float32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) float32[i] = i16[i]! / 32767;
    } else {
      float32 = new Float32Array(bytes.buffer);
    }
    syncedKeys.add(key);
    void storeSamplesLocal(key, float32).then(() => {
      // Notify the AudioEditor that samples arrived.
      window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: key }));
    });
  } catch {
    // ignore decode errors
  }
}

/** Check if a sampleKey has been synced (exists in the Yjs sync map). */
export function isSampleSynced(sampleKey: string): boolean {
  return syncedKeys.has(sampleKey);
}

/** Bytes → base64. The naive char-by-char string concat is O(n²) (every `+=`
 *  rebuilds the whole string) and freezes the main thread for seconds on a
 *  multi-MB blob. Build in 8KB pieces via String.fromCharCode.apply — O(n)
 *  total, and 8192 is the safe apply() stack limit across JS engines. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, end))));
  }
  return btoa(parts.join(''));
}

/** Publish samples to the Yjs sync map so other peers receive them. */
function publishToSyncMap(key: string, float32: Float32Array): void {
  if (!syncMap || !syncRoom) return;
  if (float32.byteLength > SYNC_SIZE_LIMIT) {
    // Make the skip VISIBLE — silently not syncing read as "broken for
    // everyone else". The AudioEditor toasts on this event.
    window.dispatchEvent(new CustomEvent('slate:audio-sync-skipped', { detail: key }));
    return;
  }
  try {
    const doc = syncRoom.slate.doc;
    const map = syncMap;
    // Mark synced BEFORE writing: our own sets fire the local observer, and
    // without this it would pointlessly re-decode + re-store our own blob.
    syncedKeys.add(key);
    // base64 expands bytes 4/3× — decide the path from the raw size so large
    // clips never pay for a throwaway float32 encoding.
    if (float32.byteLength <= (CHUNK_CHARS * 3) / 4) {
      // Fits in one update — plain legacy float32 entry (older clients read it).
      const f32base64 = bytesToBase64(
        new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength),
      );
      doc.transact(() => {
        map.set(key, f32base64);
        clearChunks(map, key); // drop stale chunks from a previous larger publish
      });
      return;
    }
    // Chunked path: encode as int16 — half the bytes on the wire and in the
    // doc for no audible difference (16-bit is CD depth). Receivers detect the
    // encoding via the `:i16` marker on the chunk-count meta entry.
    const i16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const v = Math.max(-1, Math.min(1, float32[i]!));
      i16[i] = Math.round(v * 32767);
    }
    const base64 = bytesToBase64(new Uint8Array(i16.buffer));
    const count = Math.ceil(base64.length / CHUNK_CHARS);
    // One transaction per chunk = one bounded Yjs update per chunk.
    for (let i = 0; i < count; i++) {
      const piece = base64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      doc.transact(() => map.set(`${key}#${i}`, piece));
    }
    // Meta last: receivers assemble only once every chunk has landed. Also
    // drop the plain entry and any stale higher-index chunks from a previous
    // (larger) publish of this key.
    doc.transact(() => {
      map.delete(key);
      for (const entry of [...map.keys()]) {
        if (!entry.startsWith(`${key}#`) || entry === `${key}#meta`) continue;
        const idx = Number(entry.slice(key.length + 1));
        if (Number.isInteger(idx) && idx >= count) map.delete(entry);
      }
      map.set(`${key}#meta`, `${count}:i16`);
    });
  } catch {
    // ignore — large clips just don't sync
  }
}

/** Delete every chunk entry (+meta) for a key. Caller wraps in a transaction. */
function clearChunks(map: Y.Map<string>, key: string): void {
  for (const entry of [...map.keys()]) {
    if (entry.startsWith(`${key}#`)) map.delete(entry);
  }
}

/** Store audio samples in IndexedDB ONLY — used by the sync receive path,
 *  where re-publishing what we just received would make every peer rebroadcast
 *  the full blob back into the doc. */
async function storeSamplesLocal(key: string, samples: number[] | Float32Array): Promise<void> {
  const db = await openDB();
  // Convert to Float32Array for compactness if not already.
  const float32 = samples instanceof Float32Array ? samples : new Float32Array(samples);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(float32.buffer, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Store audio samples in IndexedDB. Accepts number[] or Float32Array. */
export async function storeSamples(key: string, samples: number[] | Float32Array): Promise<void> {
  const float32 = samples instanceof Float32Array ? samples : new Float32Array(samples);
  await storeSamplesLocal(key, float32);
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
  // Also remove from the Yjs sync map — the plain entry AND any chunks.
  if (syncMap && syncRoom) {
    const map = syncMap;
    syncRoom.slate.doc.transact(() => {
      if (map.has(key)) map.delete(key);
      clearChunks(map, key);
    });
  }
  syncedKeys.delete(key);
}

/** Convert Float32Array back to number[] (only when needed for processing). */
export function float32ToNumberArray(f32: Float32Array): number[] {
  return Array.from(f32);
}

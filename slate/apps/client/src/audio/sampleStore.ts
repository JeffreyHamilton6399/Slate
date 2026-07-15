/**
 * IndexedDB audio sample store — keeps PCM data OUT of the Yjs document.
 *
 * A 3-minute song at 44100Hz stereo = ~16M numbers = ~127MB. Storing that in
 * Yjs makes every sync, every observeDeep, every IndexedDB persistence write
 * incredibly slow. Instead, we store samples as a Float32Array blob in a
 * separate IndexedDB database, and keep only a string key in the Yjs clip.
 *
 * The key is `clipId` — lookups are O(1) via IndexedDB's key path.
 */

const DB_NAME = 'slate-audio-samples';
const STORE = 'samples';
let dbPromise: Promise<IDBDatabase> | null = null;

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

/** Store audio samples in IndexedDB. Accepts number[] or Float32Array. */
export async function storeSamples(key: string, samples: number[] | Float32Array): Promise<void> {
  const db = await openDB();
  // Convert to Float32Array for compactness if not already.
  const float32 = samples instanceof Float32Array ? samples : new Float32Array(samples);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(float32.buffer, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Convert Float32Array back to number[] (only when needed for processing). */
export function float32ToNumberArray(f32: Float32Array): number[] {
  return Array.from(f32);
}

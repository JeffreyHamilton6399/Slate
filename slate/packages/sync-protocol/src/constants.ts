/** Wire-level limits applied by both client and server. */
export const PROTOCOL_VERSION = 1;

/** Largest single Yjs update we accept (bytes).
 *
 *  This must comfortably exceed the largest LEGITIMATE single update a client
 *  can produce, because the relay doesn't just reject oversized updates — it
 *  drops the connection, and since the data is already committed to the local
 *  doc the client re-sends it on every reconnect: one oversized update makes
 *  the board permanently unsyncable for that peer. Real cases that blew the
 *  old 1 MB cap: a large imported 3D mesh (vertex arrays live in the doc), an
 *  initial SyncStep2 of a board authored while the server slept, and (before
 *  chunking) a base64 audio sample blob.
 *
 *  The dominant term is the initial SyncStep2 after the server lost its copy
 *  (free-tier restarts wipe the disk): the client sends its ENTIRE doc as one
 *  message, including the audio sample-sync map. That map is bounded client-
 *  side by AUDIO_SYNC_BUDGET_CHARS; 48 MB = that budget + meshes/strokes +
 *  Yjs framing headroom, while still bounding what a hostile client can make
 *  the server buffer per message.
 *
 *  IMPORTANT: the server's websocket `maxPayload` must be ≥ this value — the
 *  transport kills the socket BEFORE the relay sees the message, which is
 *  exactly the reconnect-flap this constant exists to prevent (the server
 *  imports it for that reason). */
export const MAX_UPDATE_BYTES = 48_000_000;

/** Total base64 chars allowed in the audio sample-sync Y.Map (~32 MB ≈ 24 MB
 *  of int16 PCM ≈ one full song plus a pile of one-shots). The map lives in
 *  the Yjs doc forever, so an unbounded map eventually makes the post-restart
 *  SyncStep2 exceed MAX_UPDATE_BYTES and the board unsyncable. Publishers
 *  must skip (with a visible toast) once the budget is spent. */
export const AUDIO_SYNC_BUDGET_CHARS = 32_000_000;

/** Largest single chat message (chars). */
export const MAX_CHAT_LEN = 2000;

/** Largest display name (chars). */
export const MAX_NAME_LEN = 40;

/** Largest board name (chars). */
export const MAX_BOARD_NAME_LEN = 80;

/** Largest topic (chars). */
export const MAX_TOPIC_LEN = 200;

/** Max chat messages kept on server before pruning. */
export const CHAT_BUFFER = 500;

/** Awareness throttle for cursor broadcasts. */
export const CURSOR_THROTTLE_MS = 33; // ~30 Hz

/** Auto-save snapshot interval. */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** Per-connection update rate limit (messages per second). Generous:
 *  cursor moves (~16/s) + awareness + sync bursts must fit with headroom —
 *  exceeding this closes the connection, which users see as the status
 *  pill flapping between connecting and online. */
export const RATE_LIMIT_UPDATES_PER_SEC = 240;

/** Soft cap on objects in a 3D scene before warning the user. */
export const SCENE3D_SOFT_LIMIT = 5_000;

/** Soft cap on strokes per board before warning the user. */
export const STROKES_SOFT_LIMIT = 50_000;

/** Top-level Yjs document keys — kept short on the wire. */
export const DOC_KEYS = {
  meta: 'meta',
  shapes: 'shapes',
  strokes: 'strokes',
  layers: 'layers',
  scene3d: 'scene3d',
  audio: 'audio',
  notes: 'notes',
  chat: 'chat',
} as const;

export const SCENE3D_KEYS = {
  objects: 'objects',
  meshes: 'meshes',
  materials: 'materials',
} as const;

export const AUDIO_KEYS = {
  tracks: 'tracks',
  clips: 'clips',
  bpm: 'bpm',
} as const;

/** Wire-level limits applied by both client and server. */
export const PROTOCOL_VERSION = 1;

/** Largest single Yjs update we accept (bytes). 1 MB is plenty for normal use. */
export const MAX_UPDATE_BYTES = 1_000_000;

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

/** Per-connection update rate limit (updates per second). */
export const RATE_LIMIT_UPDATES_PER_SEC = 60;

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
  notes: 'notes',
  chat: 'chat',
} as const;

export const SCENE3D_KEYS = {
  objects: 'objects',
  meshes: 'meshes',
  materials: 'materials',
} as const;

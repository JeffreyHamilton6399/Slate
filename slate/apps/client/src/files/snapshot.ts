/**
 * Plain-JS snapshot of a Slate document — the format used for "Save", "Save
 * As", and "Open".
 *
 * Storage strategy:
 *   - Each saved snapshot is a `slate-v2` JSON blob with full scene state.
 *   - Snapshots are stored in localStorage under `slate.saves.v1`. Server
 *     persistence is provided automatically by Hocuspocus for live boards;
 *     these manual saves are for "named recoverable points" the user picks.
 *
 * Importing a snapshot replaces the current Y.Doc state inside a single Yjs
 * transaction (so it's one undo step).
 */

import * as Y from 'yjs';
import type {
  AudioClip,
  AudioTrack,
  ChatMessage,
  DocMode,
  Layer,
  Material,
  MeshData,
  NoteSection,
  Object3D,
  Shape,
  SlateDocSnapshot,
  Stroke,
} from '@slate/sync-protocol';
import {
  chatMessageSchema,
  layerSchema,
  materialSchema,
  meshDataSchema,
  noteSectionSchema,
  object3DSchema,
  shapeSchema,
  strokeSchema,
} from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { readMeta } from '../sync/doc';
import { docTextToJson, jsonToDocText, type PmJsonNode } from '../docs/docTextJson';

const SCHEMA_VERSION = 'slate-v2';

export interface SavedSnapshot {
  schema: typeof SCHEMA_VERSION;
  savedAt: number;
  boardName: string;
  data: SlateDocSnapshot;
}

export function snapshotDoc(room: SlateRoom): SavedSnapshot {
  const slate = room.slate;
  const meta = readMeta(slate);
  const shapes: Record<string, Shape> = {};
  slate.shapes().forEach((m, id) => {
    const sh = parseShape(m, id);
    if (sh) shapes[sh.id] = sh;
  });
  const strokes: Record<string, Stroke> = {};
  slate.strokes().forEach((m, id) => {
    const st = parseStroke(m, id);
    if (st) strokes[st.id] = st;
  });
  const layers: Layer[] = [];
  slate.layers().forEach((m) => {
    const parsed = layerSchema.safeParse(plainObj(m));
    if (parsed.success) layers.push(parsed.data);
  });
  const objects: Record<string, Object3D> = {};
  slate.scene3dObjects().forEach((m, id) => {
    const o = parseObject(m, id);
    if (o) objects[o.id] = o;
  });
  const meshes: Record<string, MeshData> = {};
  slate.scene3dMeshes().forEach((m, id) => {
    const parsed = meshDataSchema.safeParse({ id, vertices: m.get('vertices'), faces: m.get('faces') });
    if (parsed.success) meshes[parsed.data.id] = parsed.data;
  });
  const materials: Record<string, Material> = {};
  slate.scene3dMaterials().forEach((m, id) => {
    const parsed = materialSchema.safeParse({ ...plainObj(m), id });
    if (parsed.success) materials[parsed.data.id] = parsed.data;
  });
  const notes: NoteSection[] = [];
  slate.notes().forEach((m) => {
    const parsed = noteSectionSchema.safeParse(plainObj(m));
    if (parsed.success) notes.push(parsed.data);
  });
  const chat: ChatMessage[] = [];
  slate.chat().forEach((m) => {
    const parsed = chatMessageSchema.safeParse(plainObj(m));
    if (parsed.success) chat.push(parsed.data);
  });

  return {
    schema: SCHEMA_VERSION,
    savedAt: Date.now(),
    boardName: meta.name ?? room.room,
    data: {
      meta: {
        createdBy: meta.createdBy ?? '',
        createdAt: meta.createdAt ?? Date.now(),
        name: meta.name ?? room.room,
        topic: meta.topic ?? '',
        visibility: meta.visibility ?? 'public',
        mode: meta.mode ?? '2d',
        paper: meta.paper ?? '#0c0c0e',
        hostId: meta.hostId ?? '',
      },
      shapes,
      strokes,
      layers,
      scene3d: { objects, meshes, materials },
      audio: {
        tracks: Array.from(slate.audioTracks().values()).map((m) => plainObj(m) as unknown as AudioTrack).filter(Boolean),
        clips: Array.from(slate.audioClips().values()).map((m) => plainObj(m) as unknown as AudioClip).filter(Boolean),
        bpm: slate.audioBpm(),
      },
      notes,
      chat,
      // Rich text for 'doc' boards (PM-shaped JSON). Cheap no-op ({} content)
      // on other modes; captured unconditionally so a board that switched
      // modes never silently loses its document. Guard against the fragment
      // not being integrated into the Yjs doc yet (happens on fresh boards).
      docText: safeDocTextToJson(slate),
      codeFiles: snapshotCodeFiles(slate),
    },
  };
}

/** Safely serialize the doc text fragment to JSON. Returns empty doc on any error. */
function safeDocTextToJson(slate: SlateRoom['slate']): PmJsonNode {
  try {
    const fragment = slate.docText();
    if (!fragment) return { type: 'doc', content: [] };
    return docTextToJson(fragment);
  } catch {
    return { type: 'doc', content: [] };
  }
}

/** Capture 'code' board files: id/name pairs + each file's text. */
function snapshotCodeFiles(slate: SlateRoom['slate']): { files: { id: string; name: string }[]; contents: Record<string, string> } {
  const files: { id: string; name: string }[] = [];
  const contents: Record<string, string> = {};
  try {
    slate.codeFiles().forEach((m, id) => {
      const name = m.get('name');
    if (typeof name !== 'string' || name.length === 0) return;
    files.push({ id, name });
    contents[id] = slate.codeText(id).toString();
    });
  } catch {
    // ignore — return what we have
  }
  return { files, contents };
}

export function applySnapshot(room: SlateRoom, snapshot: SavedSnapshot): void {
  if (snapshot.schema !== SCHEMA_VERSION) {
    throw new Error(`unsupported snapshot schema ${snapshot.schema}`);
  }
  const slate = room.slate;
  slate.doc.transact(() => {
    // Reset all containers.
    const shapes = slate.shapes();
    shapes.forEach((_, k) => shapes.delete(k));
    const strokes = slate.strokes();
    strokes.forEach((_, k) => strokes.delete(k));
    const layers = slate.layers();
    layers.delete(0, layers.length);
    const objects = slate.scene3dObjects();
    objects.forEach((_, k) => objects.delete(k));
    const meshes = slate.scene3dMeshes();
    meshes.forEach((_, k) => meshes.delete(k));
    const materials = slate.scene3dMaterials();
    materials.forEach((_, k) => materials.delete(k));
    const audioTracks = slate.audioTracks();
    audioTracks.forEach((_, k) => audioTracks.delete(k));
    const audioClips = slate.audioClips();
    audioClips.forEach((_, k) => audioClips.delete(k));
    const notes = slate.notes();
    notes.delete(0, notes.length);
    const chat = slate.chat();
    chat.delete(0, chat.length);

    // Re-hydrate.
    const meta = slate.meta();
    for (const [k, v] of Object.entries(snapshot.data.meta)) meta.set(k, v);
    for (const sh of Object.values(snapshot.data.shapes)) shapes.set(sh.id, toYMap(sh));
    for (const st of Object.values(snapshot.data.strokes)) strokes.set(st.id, toYMap(st));
    for (const l of snapshot.data.layers) layers.push([toYMap(l)]);
    for (const o of Object.values(snapshot.data.scene3d.objects)) objects.set(o.id, toYMap(o));
    for (const m of Object.values(snapshot.data.scene3d.meshes)) meshes.set(m.id, toYMap(m));
    for (const m of Object.values(snapshot.data.scene3d.materials)) materials.set(m.id, toYMap(m));
    // Re-hydrate audio tracks + clips.
    const snap = snapshot.data as Partial<SlateDocSnapshot>;
    if (snap.audio) {
      for (const t of snap.audio.tracks ?? []) audioTracks.set(t.id, toYMap(t));
      for (const c of snap.audio.clips ?? []) audioClips.set(c.id, toYMap(c));
      const audioMap = slate.doc.getMap('audio');
      audioMap.set('bpm', snap.audio.bpm ?? 120);
    }
    for (const n of snapshot.data.notes) notes.push([toYMap(n)]);
    for (const c of snapshot.data.chat) chat.push([toYMap(c)]);
    // Rich-text document (absent on snapshots from older clients).
    try {
      if (snap.docText !== undefined) jsonToDocText(slate.docText(), snap.docText);
    } catch { /* fragment not ready */ }
    // Code files: reset the map, then re-point each id at restored content.
    try {
      if (snap.codeFiles) {
        const codeFiles = slate.codeFiles();
        codeFiles.forEach((_, k) => codeFiles.delete(k));
        for (const f of snap.codeFiles.files) {
          const m = new Y.Map<unknown>();
          m.set('name', f.name);
          codeFiles.set(f.id, m);
          const text = slate.codeText(f.id);
          if (text.length > 0) text.delete(0, text.length);
          const restored = snap.codeFiles.contents[f.id];
          if (restored) text.insert(0, restored);
        }
      }
    } catch { /* code files not ready */ }
  });
}

function toYMap(obj: object): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) m.set(k, v);
  return m;
}

function plainObj(m: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  m.forEach((v, k) => (out[k] = v));
  return out;
}

function parseShape(m: Y.Map<unknown>, id: string) {
  const candidate = { ...plainObj(m), id };
  const parsed = shapeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
function parseStroke(m: Y.Map<unknown>, id: string) {
  const candidate = { ...plainObj(m), id };
  const parsed = strokeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
function parseObject(m: Y.Map<unknown>, id: string) {
  const candidate = { ...plainObj(m), id };
  const parsed = object3DSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ── Local store of saves ─────────────────────────────────────────────────────
const KEY = 'slate.saves.v1';

export interface SaveIndexEntry {
  id: string;
  boardName: string;
  label: string;
  savedAt: number;
  mode: DocMode;
  /** Approximate byte size, kept loose for UI display. */
  approxBytes: number;
}

export function listSaves(): SaveIndexEntry[] {
  try {
    const raw = localStorage.getItem(`${KEY}.index`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SaveIndexEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadSave(id: string): SavedSnapshot | null {
  try {
    const raw = localStorage.getItem(`${KEY}.${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSnapshot;
    if (parsed.schema !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Stable per-board slot ids — saving to these OVERWRITES the previous save
 *  (Google-Drive style: one living document, not a pile of timestamped
 *  copies). "Save as…" still mints unique ids for named recovery points. */
export function autosaveSlotId(boardName: string): string {
  return `autosave:${boardName}`;
}
export function manualSlotId(boardName: string): string {
  return `manual:${boardName}`;
}

/** Drop legacy per-timestamp autosave entries that used to pile up. */
export function pruneLegacyAutosaves(boardName: string): void {
  for (const e of listSaves()) {
    if (e.boardName === boardName && e.label.startsWith('autosave • ')) deleteSave(e.id);
  }
}

/** Fired after every persistSave — the cloud-backup bridge listens here. */
type SaveListener = (entry: SaveIndexEntry, snapshot: SavedSnapshot) => void;
const saveListeners = new Set<SaveListener>();
export function onSavePersisted(cb: SaveListener): () => void {
  saveListeners.add(cb);
  return () => saveListeners.delete(cb);
}

/** Fired after every deleteSave — the cloud-backup bridge listens here so it
 *  can mirror the deletion to Supabase (otherwise restoreSavesFromCloud would
 *  pull the deleted save back on next refresh). */
type DeleteListener = (saveId: string) => void;
const deleteListeners = new Set<DeleteListener>();
export function onDeleteSave(cb: DeleteListener): () => void {
  deleteListeners.add(cb);
  return () => deleteListeners.delete(cb);
}

export function persistSave(snapshot: SavedSnapshot, label?: string, id?: string): SaveIndexEntry {
  const saveId = id ?? `${snapshot.boardName}-${snapshot.savedAt}`;
  const serialized = JSON.stringify(snapshot);
  const entry: SaveIndexEntry = {
    id: saveId,
    boardName: snapshot.boardName,
    label: label ?? defaultLabel(snapshot),
    savedAt: snapshot.savedAt,
    mode: snapshot.data.meta.mode,
    approxBytes: serialized.length,
  };
  const next = [entry, ...listSaves().filter((e) => e.id !== saveId)].slice(0, 50);
  // localStorage has a ~5-10MB origin cap. A big board's snapshot can push it
  // over, and a naive setItem then THROWS — which the autosave loop swallowed,
  // so saving silently stopped working. Write the blob with quota eviction:
  // drop the OLDEST other saves and retry until it fits (or we're out of
  // victims). The index is written last, reflecting whatever survived.
  const survived = writeBlobWithEviction(`${KEY}.${saveId}`, serialized, next, saveId);
  localStorage.setItem(`${KEY}.index`, JSON.stringify(survived));
  for (const cb of saveListeners) cb(entry, snapshot);
  return entry;
}

/** Try to write `serialized`; on QuotaExceeded, evict the oldest OTHER saves
 *  (mutating a copy of `index`) and retry. Returns the surviving index. Throws
 *  only if the blob can't fit even with every other save gone. */
function writeBlobWithEviction(
  blobKey: string,
  serialized: string,
  index: SaveIndexEntry[],
  keepId: string,
): SaveIndexEntry[] {
  const idx = [...index];
  const isQuota = (e: unknown) =>
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
  for (;;) {
    try {
      localStorage.setItem(blobKey, serialized);
      return idx;
    } catch (e) {
      if (!isQuota(e)) throw e;
      // Evict the single oldest save that isn't the one we're writing.
      let victimAt = Infinity;
      let victimI = -1;
      for (let i = 0; i < idx.length; i++) {
        if (idx[i]!.id !== keepId && idx[i]!.savedAt < victimAt) { victimAt = idx[i]!.savedAt; victimI = i; }
      }
      if (victimI < 0) throw e; // nothing left to evict — genuinely too big
      const victim = idx.splice(victimI, 1)[0]!;
      try { localStorage.removeItem(`${KEY}.${victim.id}`); } catch { /* ignore */ }
    }
  }
}

export function deleteSave(id: string): void {
  const list = listSaves().filter((e) => e.id !== id);
  localStorage.setItem(`${KEY}.index`, JSON.stringify(list));
  localStorage.removeItem(`${KEY}.${id}`);
  for (const cb of deleteListeners) cb(id);
}

function defaultLabel(s: SavedSnapshot): string {
  const d = new Date(s.savedAt);
  return `${s.boardName} — ${d.toLocaleString()}`;
}

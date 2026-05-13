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
  ChatMessage,
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
      notes,
      chat,
    },
  };
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
    for (const n of snapshot.data.notes) notes.push([toYMap(n)]);
    for (const c of snapshot.data.chat) chat.push([toYMap(c)]);
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

interface SaveIndexEntry {
  id: string;
  boardName: string;
  label: string;
  savedAt: number;
  mode: '2d' | '3d';
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

export function persistSave(snapshot: SavedSnapshot, label?: string): SaveIndexEntry {
  const id = `${snapshot.boardName}-${snapshot.savedAt}`;
  const serialized = JSON.stringify(snapshot);
  const entry: SaveIndexEntry = {
    id,
    boardName: snapshot.boardName,
    label: label ?? defaultLabel(snapshot),
    savedAt: snapshot.savedAt,
    mode: snapshot.data.meta.mode,
    approxBytes: serialized.length,
  };
  const list = listSaves();
  const next = [entry, ...list.filter((e) => e.id !== id)].slice(0, 50);
  localStorage.setItem(`${KEY}.index`, JSON.stringify(next));
  localStorage.setItem(`${KEY}.${id}`, serialized);
  return entry;
}

export function deleteSave(id: string): void {
  const list = listSaves().filter((e) => e.id !== id);
  localStorage.setItem(`${KEY}.index`, JSON.stringify(list));
  localStorage.removeItem(`${KEY}.${id}`);
}

function defaultLabel(s: SavedSnapshot): string {
  const d = new Date(s.savedAt);
  return `${s.boardName} — ${d.toLocaleString()}`;
}

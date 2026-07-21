/**
 * Slate document construction + safe accessors. Each board is one Y.Doc.
 *
 * The schema in packages/sync-protocol describes the plain-JS shape; this
 * file exposes typed getters for the corresponding Y.Map / Y.Array containers
 * so call sites don't sprinkle string keys everywhere.
 *
 * Collections (scene objects/meshes/materials, audio tracks/clips) are stored
 * as TOP-LEVEL Yjs types (`doc.getMap(name)`), NOT as nested Y.Maps set into a
 * parent map. This is deliberate: `doc.getMap(name)` is idempotent and keyed by
 * name globally, so every client resolves the exact same shared container with
 * no conflict. Nesting a freshly-`new Y.Map()` under a parent key — as an
 * earlier version did on every doc open — makes each client set a *different*
 * map object for the same key; when they sync, Yjs keeps one and discards the
 * other's contents (a clientId coin-flip), so imported models / audio clips
 * would vanish for other peers until a page refresh re-rolled the dice.
 * `migrateLegacyContainers` copies any data written under the old nested layout
 * into the top-level containers so existing boards don't lose their contents.
 */

import * as Y from 'yjs';
import {
  DOC_KEYS,
  SCENE3D_KEYS,
  AUDIO_KEYS,
  DOC_TEXT_KEY,
  CODE_FILES_KEY,
  codeTextKey,
  DIAGRAM_NODES_KEY,
  DIAGRAM_EDGES_KEY,
  type BoardMeta,
  type DocMode,
} from '@slate/sync-protocol';

/** Top-level container names. Flat + globally keyed so `doc.getMap` returns the
 *  same shared type on every client with no create-time conflict. Prefixed to
 *  stay clear of the other top-level keys (shapes, strokes, notes, …). */
const CONTAINER_KEYS = {
  objects: 'scene3d:objects',
  meshes: 'scene3d:meshes',
  materials: 'scene3d:materials',
  audioTracks: 'audio:tracks',
  audioClips: 'audio:clips',
} as const;

export interface SlateDoc {
  doc: Y.Doc;
  meta: () => Y.Map<unknown>;
  shapes: () => Y.Map<Y.Map<unknown>>;
  strokes: () => Y.Map<Y.Map<unknown>>;
  layers: () => Y.Array<Y.Map<unknown>>;
  scene3dObjects: () => Y.Map<Y.Map<unknown>>;
  scene3dMeshes: () => Y.Map<Y.Map<unknown>>;
  scene3dMaterials: () => Y.Map<Y.Map<unknown>>;
  audioTracks: () => Y.Map<Y.Map<unknown>>;
  audioClips: () => Y.Map<Y.Map<unknown>>;
  audioBpm: () => number;
  notes: () => Y.Array<Y.Map<unknown>>;
  chat: () => Y.Array<Y.Map<unknown>>;
  /** Curated asset library (folders / mesh assets / material assets). */
  assets: () => Y.Map<Y.Map<unknown>>;
  /** Rich-text document for 'doc' boards (bound to TipTap via y-prosemirror). */
  docText: () => Y.XmlFragment;
  /** 'code' boards: file id → Y.Map { name }. */
  codeFiles: () => Y.Map<Y.Map<unknown>>;
  /** A code file's shared text content (top-level Y.Text keyed by file id). */
  codeText: (fileId: string) => Y.Text;
  /** 'diagram' boards: node id → Y.Map (a DiagramNode). */
  diagramNodes: () => Y.Map<Y.Map<unknown>>;
  /** 'diagram' boards: edge id → Y.Map (a DiagramEdge). */
  diagramEdges: () => Y.Map<Y.Map<unknown>>;
}

export function createSlateDoc(): SlateDoc {
  const doc = new Y.Doc();
  return {
    doc,
    meta: () => doc.getMap<unknown>(DOC_KEYS.meta),
    shapes: () => doc.getMap<Y.Map<unknown>>(DOC_KEYS.shapes),
    strokes: () => doc.getMap<Y.Map<unknown>>(DOC_KEYS.strokes),
    layers: () => doc.getArray<Y.Map<unknown>>(DOC_KEYS.layers),
    scene3dObjects: () => doc.getMap<Y.Map<unknown>>(CONTAINER_KEYS.objects),
    scene3dMeshes: () => doc.getMap<Y.Map<unknown>>(CONTAINER_KEYS.meshes),
    scene3dMaterials: () => doc.getMap<Y.Map<unknown>>(CONTAINER_KEYS.materials),
    audioTracks: () => doc.getMap<Y.Map<unknown>>(CONTAINER_KEYS.audioTracks),
    audioClips: () => doc.getMap<Y.Map<unknown>>(CONTAINER_KEYS.audioClips),
    audioBpm: () => {
      const a = doc.getMap<unknown>(DOC_KEYS.audio);
      return (a.get(AUDIO_KEYS.bpm) as number | undefined) ?? 120;
    },
    notes: () => doc.getArray<Y.Map<unknown>>(DOC_KEYS.notes),
    chat: () => doc.getArray<Y.Map<unknown>>(DOC_KEYS.chat),
    assets: () => doc.getMap<Y.Map<unknown>>('assets'),
    docText: () => doc.getXmlFragment(DOC_TEXT_KEY),
    codeFiles: () => doc.getMap<Y.Map<unknown>>(CODE_FILES_KEY),
    codeText: (fileId: string) => doc.getText(codeTextKey(fileId)),
    diagramNodes: () => doc.getMap<Y.Map<unknown>>(DIAGRAM_NODES_KEY),
    diagramEdges: () => doc.getMap<Y.Map<unknown>>(DIAGRAM_EDGES_KEY),
  };
}

/**
 * Copy any collection data written under the OLD nested layout
 * (`scene3d.objects`, `audio.tracks`, …) up into the top-level containers.
 * Idempotent — only copies ids the destination doesn't already have — and safe
 * to run on every client (concurrent runs write identical id→value pairs). Call
 * after IndexedDB hydration and again after the first server sync so data from
 * either source is lifted into the shared containers.
 */
export function migrateLegacyContainers(doc: Y.Doc): void {
  const scene3d = doc.getMap<unknown>(DOC_KEYS.scene3d);
  const audio = doc.getMap<unknown>(DOC_KEYS.audio);
  copyLegacy(doc, scene3d, SCENE3D_KEYS.objects, CONTAINER_KEYS.objects);
  copyLegacy(doc, scene3d, SCENE3D_KEYS.meshes, CONTAINER_KEYS.meshes);
  copyLegacy(doc, scene3d, SCENE3D_KEYS.materials, CONTAINER_KEYS.materials);
  copyLegacy(doc, audio, AUDIO_KEYS.tracks, CONTAINER_KEYS.audioTracks);
  copyLegacy(doc, audio, AUDIO_KEYS.clips, CONTAINER_KEYS.audioClips);
}

function copyLegacy(doc: Y.Doc, parent: Y.Map<unknown>, oldKey: string, topName: string): void {
  const old = parent.get(oldKey) as Y.Map<Y.Map<unknown>> | undefined;
  if (!(old instanceof Y.Map) || old.size === 0) return;
  const dest = doc.getMap<Y.Map<unknown>>(topName);
  doc.transact(() => {
    old.forEach((child, id) => {
      if (dest.has(id) || !(child instanceof Y.Map)) return;
      // Entries are plain-JS values (primitives / arrays / plain objects) — a
      // shallow copy into a fresh Y.Map is enough; there are no nested Y types.
      const clone = new Y.Map<unknown>();
      child.forEach((v, k) => clone.set(k, v));
      dest.set(id, clone);
    });
  });
}

/** Read board meta as a plain JS object (or null if not yet populated). */
export function readMeta(slate: SlateDoc): Partial<BoardMeta> {
  const m = slate.meta();
  return {
    createdBy: m.get('createdBy') as string | undefined,
    createdAt: m.get('createdAt') as number | undefined,
    name: m.get('name') as string | undefined,
    topic: m.get('topic') as string | undefined,
    visibility: m.get('visibility') as BoardMeta['visibility'] | undefined,
    mode: m.get('mode') as DocMode | undefined,
    paper: m.get('paper') as string | undefined,
    hostId: m.get('hostId') as string | undefined,
  };
}

/** Initialize meta on a brand-new doc (first writer wins). */
export function initMetaIfEmpty(
  slate: SlateDoc,
  init: BoardMeta,
): void {
  const m = slate.meta();
  if (m.has('createdBy')) return;
  slate.doc.transact(() => {
    m.set('createdBy', init.createdBy);
    m.set('createdAt', init.createdAt);
    m.set('name', init.name);
    m.set('topic', init.topic);
    m.set('visibility', init.visibility);
    m.set('mode', init.mode);
    m.set('paper', init.paper);
    m.set('hostId', init.hostId);
  }, { local: true });
}

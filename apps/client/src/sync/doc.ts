/**
 * Slate document construction + safe accessors. Each board is one Y.Doc.
 *
 * The schema in packages/sync-protocol describes the plain-JS shape; this
 * file exposes typed getters for the corresponding Y.Map / Y.Array containers
 * so call sites don't sprinkle string keys everywhere.
 */

import * as Y from 'yjs';
import {
  DOC_KEYS,
  SCENE3D_KEYS,
  type BoardMeta,
  type DocMode,
} from '@slate/sync-protocol';

export interface SlateDoc {
  doc: Y.Doc;
  meta: () => Y.Map<unknown>;
  shapes: () => Y.Map<Y.Map<unknown>>;
  strokes: () => Y.Map<Y.Map<unknown>>;
  layers: () => Y.Array<Y.Map<unknown>>;
  scene3dObjects: () => Y.Map<Y.Map<unknown>>;
  scene3dMeshes: () => Y.Map<Y.Map<unknown>>;
  scene3dMaterials: () => Y.Map<Y.Map<unknown>>;
  notes: () => Y.Array<Y.Map<unknown>>;
  chat: () => Y.Array<Y.Map<unknown>>;
}

export function createSlateDoc(): SlateDoc {
  const doc = new Y.Doc();
  const scene3d = doc.getMap<unknown>(DOC_KEYS.scene3d);
  // Pre-create nested containers so first writes are no-conflicts.
  scene3d.set(SCENE3D_KEYS.objects, new Y.Map<Y.Map<unknown>>());
  scene3d.set(SCENE3D_KEYS.meshes, new Y.Map<Y.Map<unknown>>());
  scene3d.set(SCENE3D_KEYS.materials, new Y.Map<Y.Map<unknown>>());

  return {
    doc,
    meta: () => doc.getMap<unknown>(DOC_KEYS.meta),
    shapes: () => doc.getMap<Y.Map<unknown>>(DOC_KEYS.shapes),
    strokes: () => doc.getMap<Y.Map<unknown>>(DOC_KEYS.strokes),
    layers: () => doc.getArray<Y.Map<unknown>>(DOC_KEYS.layers),
    scene3dObjects: () => {
      const s = doc.getMap<unknown>(DOC_KEYS.scene3d);
      let m = s.get(SCENE3D_KEYS.objects) as Y.Map<Y.Map<unknown>> | undefined;
      if (!m) {
        m = new Y.Map<Y.Map<unknown>>();
        s.set(SCENE3D_KEYS.objects, m);
      }
      return m;
    },
    scene3dMeshes: () => {
      const s = doc.getMap<unknown>(DOC_KEYS.scene3d);
      let m = s.get(SCENE3D_KEYS.meshes) as Y.Map<Y.Map<unknown>> | undefined;
      if (!m) {
        m = new Y.Map<Y.Map<unknown>>();
        s.set(SCENE3D_KEYS.meshes, m);
      }
      return m;
    },
    scene3dMaterials: () => {
      const s = doc.getMap<unknown>(DOC_KEYS.scene3d);
      let m = s.get(SCENE3D_KEYS.materials) as Y.Map<Y.Map<unknown>> | undefined;
      if (!m) {
        m = new Y.Map<Y.Map<unknown>>();
        s.set(SCENE3D_KEYS.materials, m);
      }
      return m;
    },
    notes: () => doc.getArray<Y.Map<unknown>>(DOC_KEYS.notes),
    chat: () => doc.getArray<Y.Map<unknown>>(DOC_KEYS.chat),
  };
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

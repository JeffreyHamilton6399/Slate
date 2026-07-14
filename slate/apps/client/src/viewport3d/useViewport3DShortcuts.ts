/**
 * Keyboard shortcut hook for the 3D viewport.
 *
 * Mirrors Blender's defaults (G/R/S, X/Y/Z axis lock, Tab edit/object mode,
 * 1/2/3 vert/edge/face submodes, Shift+D duplicate, Shift+A add, H hide,
 * Alt+H unhide, F frame selected, X/Delete delete, Ctrl+Z undo). The hook
 * is mounted by the viewport component and active while no input/textarea
 * has focus.
 */

import { useEffect } from 'react';
import { useScene3DStore } from './store';
import { deleteObjects, duplicateObjects, insertKeyframe, joinObjects } from './scene';
import { runEditOp } from './editModeTools';
import type { SlateRoom } from '../sync/provider';

interface Options {
  room: SlateRoom;
  onFrameSelected: () => void;
  onFrameAll: () => void;
  onStartModal: (kind: 'grab' | 'rotate' | 'scale') => void;
  onStartMeshModal: (
    kind: 'grab' | 'extrude' | 'rotate' | 'scale' | 'bevel' | 'inset' | 'loop-cut',
  ) => void;
  onCancelModal: () => void;
  onConfirmModal: () => void;
  /** Shift+A — open the add-object menu at the cursor. */
  onOpenAddMenu: () => void;
}

export function useViewport3DShortcuts(opts: Options): void {
  const setEditorMode = useScene3DStore((s) => s.setEditorMode);
  const setSelectMode = useScene3DStore((s) => s.setSelectMode);
  const toggleGrid = useScene3DStore((s) => s.toggleGrid);
  const toggleWireframe = useScene3DStore((s) => s.toggleWireframe);
  const toggleRendered = useScene3DStore((s) => s.toggleRendered);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const store = useScene3DStore.getState();
      // Fly mode owns the keyboard (WASD is navigation, not tools).
      if (store.flying) return;
      const modal = store.modal;
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const k = e.key.toLowerCase();

      // While a modal tool is running, route keys to the modal.
      if (modal.tool) {
        if (k === 'enter' || k === ' ') {
          e.preventDefault();
          opts.onConfirmModal();
          return;
        }
        if (k === 'escape') {
          e.preventDefault();
          opts.onCancelModal();
          return;
        }
        // x/y/z + numeric handled inside the modal driver via a global listener;
        // we just don't switch tool while modal.
        return;
      }

      if (ctrl && k === 'z') {
        e.preventDefault();
        if (shift) opts.room.undo.redo();
        else opts.room.undo.undo();
        return;
      }
      if (ctrl && k === 'j') {
        // Ctrl+J → join selected objects into one (Blender).
        if (store.editorMode === 'object' && store.selection.length >= 2) {
          e.preventDefault();
          const joined = joinObjects(opts.room.slate, store.selection);
          if (joined) store.setSelection([joined]);
        }
        return;
      }
      if (k === 'tab') {
        e.preventDefault();
        setEditorMode(store.editorMode === 'object' ? 'edit' : 'object');
        return;
      }
      if (!ctrl && (k === '1' || k === '2' || k === '3')) {
        e.preventDefault();
        setSelectMode(k === '1' ? 'vertex' : k === '2' ? 'edge' : 'face');
        return;
      }
      if (k === 'g') {
        e.preventDefault();
        // Edit mode with a sub-element selection: drag those verts instead
        // of moving the whole object.
        const sub = store.editSelection;
        if (
          store.editorMode === 'edit' &&
          (sub.verts.length > 0 || sub.edges.length > 0 || sub.faces.length > 0)
        ) {
          opts.onStartMeshModal('grab');
        } else {
          opts.onStartModal('grab');
        }
        return;
      }
      if (k === 'r' && !ctrl) {
        e.preventDefault();
        const sub = store.editSelection;
        if (
          store.editorMode === 'edit' &&
          (sub.verts.length > 0 || sub.edges.length > 0 || sub.faces.length > 0)
        ) {
          opts.onStartMeshModal('rotate');
        } else {
          opts.onStartModal('rotate');
        }
        return;
      }
      if (k === 's' && !ctrl) {
        e.preventDefault();
        const sub = store.editSelection;
        if (
          store.editorMode === 'edit' &&
          (sub.verts.length > 0 || sub.edges.length > 0 || sub.faces.length > 0)
        ) {
          opts.onStartMeshModal('scale');
        } else {
          opts.onStartModal('scale');
        }
        return;
      }
      if (k === 'i' && !ctrl && store.editorMode === 'object' && store.selection.length > 0) {
        // I in object mode → insert keyframe at the playhead (Blender).
        e.preventDefault();
        insertKeyframe(opts.room.slate, store.selection, store.animTime);
        return;
      }
      // Edit-mode mesh ops (only when in edit mode and one object selected).
      // Ops act on the selected faces when any are picked.
      if (store.editorMode === 'edit' && store.selection.length === 1) {
        const id = store.selection[0]!;
        const faces = store.editSelection.faces;
        if (k === 'escape' && faces.length > 0) {
          e.preventDefault();
          store.setEditSelection({ faces: [] });
          return;
        }
        if (k === 'e' && !ctrl) {
          e.preventDefault();
          // With faces picked, extrude modally (new cap follows the mouse);
          // otherwise fall back to the instant top-face extrude.
          if (faces.length > 0) opts.onStartMeshModal('extrude');
          else runEditOp('extrude', { room: opts.room, objectId: id, faces });
          return;
        }
        if (k === 'i' && !ctrl) {
          // Modal inset — thickness follows the mouse, click confirms.
          opts.onStartMeshModal('inset');
          e.preventDefault();
          return;
        }
        if (k === 'b' && ctrl) {
          // Modal bevel — amount follows the mouse, click confirms.
          opts.onStartMeshModal('bevel');
          e.preventDefault();
          return;
        }
        if (k === 'r' && ctrl) {
          // Modal loop cut — scroll changes the count, click confirms.
          opts.onStartMeshModal('loop-cut');
          e.preventDefault();
          return;
        }
        if (k === 'm' && !ctrl) {
          runEditOp('merge', { room: opts.room, objectId: id, faces, verts: store.editSelection.verts });
          e.preventDefault();
          return;
        }
        if ((k === 'x' || k === 'delete') && store.editSelection.verts.length > 0) {
          // Blender edit mode: X on picked verts deletes them (and their faces).
          runEditOp('delete-verts', { room: opts.room, objectId: id, verts: store.editSelection.verts });
          e.preventDefault();
          return;
        }
        if ((k === 'x' || k === 'delete') && faces.length > 0) {
          // Blender edit mode: X deletes the selected faces, not the object.
          runEditOp('delete-faces', { room: opts.room, objectId: id, faces });
          e.preventDefault();
          return;
        }
        if (k === 'f' && !ctrl && store.editSelection.verts.length >= 3) {
          // Blender F: fill a face from the picked verts.
          runEditOp('fill', { room: opts.room, objectId: id, verts: store.editSelection.verts });
          e.preventDefault();
          return;
        }
      }
      if (k === 'f') {
        opts.onFrameSelected();
        e.preventDefault();
        return;
      }
      if (k === '.' && !ctrl) {
        toggleGrid();
        return;
      }
      if (k === ',' && !ctrl) {
        toggleWireframe();
        return;
      }
      if (k === 'a' && shift) {
        // Shift+A → add-object menu at the cursor (Blender).
        e.preventDefault();
        opts.onOpenAddMenu();
        return;
      }
      if (k === 'a' && e.altKey) {
        // Alt+A → deselect all (Blender).
        e.preventDefault();
        if (store.editorMode === 'edit') {
          store.setEditSelection({ verts: [], edges: [], faces: [] });
        } else {
          store.clearSelection();
        }
        return;
      }
      if (k === 'a' && !ctrl) {
        // A → select all (Blender). In edit mode, select all sub-elements of
        // the current object (not every object in the scene); in object mode
        // select every object.
        e.preventDefault();
        if (store.editorMode === 'edit' && store.selection.length === 1) {
          const id = store.selection[0]!;
          const yo = opts.room.slate.scene3dObjects().get(id);
          const meshId = yo?.get('meshId') as string | null | undefined;
          if (meshId) {
            const ym = opts.room.slate.scene3dMeshes().get(meshId);
            const faces = ym?.get('faces') as { v: number[] }[] | undefined;
            if (store.selectMode === 'face' && faces) {
              store.setEditSelection({ faces: faces.map((_, i) => i), verts: [], edges: [] });
            } else if (store.selectMode === 'vertex' && faces) {
              const verts = [...new Set(faces.flatMap((f) => f.v))];
              store.setEditSelection({ verts, edges: [], faces: [] });
            } else if (store.selectMode === 'edge' && faces) {
              // All unique edges (adjacent vert pairs) across all faces.
              const edgeSet = new Set<string>();
              const edges: number[] = [];
              for (const f of faces) {
                for (let i = 0; i < f.v.length; i++) {
                  const a = f.v[i]!;
                  const b = f.v[(i + 1) % f.v.length]!;
                  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
                  if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    edges.push(Math.min(a, b), Math.max(a, b));
                  }
                }
              }
              store.setEditSelection({ edges, verts: [], faces: [] });
            }
          }
        } else {
          const ids: string[] = [];
          opts.room.slate.scene3dObjects().forEach((_, id) => ids.push(id));
          store.setSelection(ids);
        }
        return;
      }
      if (k === 'z' && !ctrl && shift) {
        // Shift+Z → toggle rendered shading (Blender).
        e.preventDefault();
        toggleRendered();
        return;
      }
      if (k === 'z' && !ctrl) {
        // Z → toggle wireframe shading (stand-in for Blender's shading pie).
        e.preventDefault();
        toggleWireframe();
        return;
      }
      if (k === 'home') {
        // Home → frame everything (Blender).
        e.preventDefault();
        opts.onFrameAll();
        return;
      }
      if (k === 'd' && shift && !ctrl) {
        // Shift+D → duplicate selection and immediately grab the copies.
        if (store.selection.length) {
          e.preventDefault();
          const copies = duplicateObjects(opts.room.slate, store.selection);
          if (copies.length) {
            store.setSelection(copies);
            // Start grab on the copies so they follow the mouse, like Blender.
            requestAnimationFrame(() => opts.onStartModal('grab'));
          }
        }
        return;
      }
      if ((k === 'delete' || k === 'x') && !ctrl) {
        if (store.selection.length) {
          e.preventDefault();
          deleteObjects(opts.room.slate, store.selection);
          store.clearSelection();
        }
        return;
      }
      if (k === 'h' && !ctrl && !shift && !e.altKey) {
        if (store.selection.length) {
          opts.room.slate.doc.transact(() => {
            const objs = opts.room.slate.scene3dObjects();
            for (const id of store.selection) {
              const yo = objs.get(id);
              if (yo) yo.set('visible', false);
            }
          });
        }
        return;
      }
      if (k === 'h' && e.altKey) {
        // Alt+H → unhide everything.
        e.preventDefault();
        opts.room.slate.doc.transact(() => {
          const objs = opts.room.slate.scene3dObjects();
          objs.forEach((yo) => {
            if (yo.get('visible') === false) yo.set('visible', true);
          });
        });
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, setEditorMode, setSelectMode, toggleGrid, toggleWireframe, toggleRendered]);
}

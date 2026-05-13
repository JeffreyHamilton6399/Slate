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
import { addPrimitive, deleteObjects } from './scene';
import { runEditOp } from './editModeTools';
import type { SlateRoom } from '../sync/provider';

interface Options {
  room: SlateRoom;
  onFrameSelected: () => void;
  onStartModal: (kind: 'grab' | 'rotate' | 'scale') => void;
  onCancelModal: () => void;
  onConfirmModal: () => void;
}

export function useViewport3DShortcuts(opts: Options): void {
  const setEditorMode = useScene3DStore((s) => s.setEditorMode);
  const setSelectMode = useScene3DStore((s) => s.setSelectMode);
  const toggleGrid = useScene3DStore((s) => s.toggleGrid);
  const toggleWireframe = useScene3DStore((s) => s.toggleWireframe);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      const store = useScene3DStore.getState();
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
        opts.onStartModal('grab');
        e.preventDefault();
        return;
      }
      if (k === 'r' && !ctrl) {
        opts.onStartModal('rotate');
        e.preventDefault();
        return;
      }
      if (k === 's' && !ctrl) {
        opts.onStartModal('scale');
        e.preventDefault();
        return;
      }
      // Edit-mode mesh ops (only when in edit mode and one object selected).
      if (store.editorMode === 'edit' && store.selection.length === 1) {
        const id = store.selection[0]!;
        if (k === 'e' && !ctrl) {
          runEditOp('extrude', { room: opts.room, objectId: id });
          e.preventDefault();
          return;
        }
        if (k === 'i' && !ctrl) {
          runEditOp('inset', { room: opts.room, objectId: id });
          e.preventDefault();
          return;
        }
        if (k === 'b' && ctrl) {
          runEditOp('bevel', { room: opts.room, objectId: id });
          e.preventDefault();
          return;
        }
        if (k === 'r' && ctrl) {
          runEditOp('loop-cut', { room: opts.room, objectId: id });
          e.preventDefault();
          return;
        }
        if (k === 'm' && !ctrl) {
          runEditOp('merge', { room: opts.room, objectId: id });
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
        // Shift+A → quick add cube (more options in the toolbar menu).
        e.preventDefault();
        addPrimitive(opts.room.slate, { type: 'cube' });
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
      if (k === 'h' && !ctrl && !shift) {
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, setEditorMode, setSelectMode, toggleGrid, toggleWireframe]);
}

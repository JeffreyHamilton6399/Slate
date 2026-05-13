/**
 * Top toolbar for the 3D viewport: mode toggle, add menu, transform tool
 * triggers, snap/space toggles, undo/redo.
 */

import {
  Box,
  Circle,
  Cylinder,
  Cone,
  Square,
  Torus,
  Plus,
  Move,
  RotateCw,
  Maximize,
  Grid3x3,
  Eye,
  Undo2,
  Redo2,
  Trash2,
  Focus,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/DropdownMenu';
import { addPrimitive, deleteObjects } from './scene';
import type { SlateRoom } from '../sync/provider';
import { useScene3DStore } from './store';
import type { Object3DType } from '@slate/sync-protocol';

interface Toolbar3DProps {
  room: SlateRoom;
  onStartModal: (k: 'grab' | 'rotate' | 'scale') => void;
  onFrameSelected: () => void;
}

const PRIMITIVES: { type: Exclude<Object3DType, 'folder' | 'mesh' | 'empty'>; label: string; Icon: typeof Box }[] = [
  { type: 'cube', label: 'Cube', Icon: Box },
  { type: 'sphere', label: 'Sphere', Icon: Circle },
  { type: 'cylinder', label: 'Cylinder', Icon: Cylinder },
  { type: 'cone', label: 'Cone', Icon: Cone },
  { type: 'plane', label: 'Plane', Icon: Square },
  { type: 'torus', label: 'Torus', Icon: Torus },
];

export function Toolbar3D({ room, onStartModal, onFrameSelected }: Toolbar3DProps) {
  const editorMode = useScene3DStore((s) => s.editorMode);
  const setEditorMode = useScene3DStore((s) => s.setEditorMode);
  const showGrid = useScene3DStore((s) => s.showGrid);
  const showWireframe = useScene3DStore((s) => s.showWireframe);
  const toggleGrid = useScene3DStore((s) => s.toggleGrid);
  const toggleWireframe = useScene3DStore((s) => s.toggleWireframe);
  const selection = useScene3DStore((s) => s.selection);
  const clearSelection = useScene3DStore((s) => s.clearSelection);

  return (
    <div className="absolute left-2 right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-bg-2/95 backdrop-blur px-2 py-1 shadow-lg">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={editorMode === 'object'}
          onClick={() => setEditorMode('object')}
          className={
            'rounded-sm px-2 py-0.5 text-xs font-mono uppercase tracking-wider border ' +
            (editorMode === 'object'
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-transparent text-text-dim hover:bg-bg-3 hover:text-text')
          }
        >
          Object
        </button>
        <button
          type="button"
          aria-pressed={editorMode === 'edit'}
          onClick={() => setEditorMode('edit')}
          className={
            'rounded-sm px-2 py-0.5 text-xs font-mono uppercase tracking-wider border ' +
            (editorMode === 'edit'
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-transparent text-text-dim hover:bg-bg-3 hover:text-text')
          }
        >
          Edit
        </button>
      </div>
      <div className="mx-1 h-5 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <Plus size={13} />
            <span className="ml-1">Add</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {PRIMITIVES.map(({ type, label, Icon }) => (
            <DropdownMenuItem
              key={type}
              onSelect={() => addPrimitive(room.slate, { type })}
            >
              <Icon size={12} />
              <span className="ml-2">{label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tooltip content="Move (G)">
        <Button variant="icon" size="none" onClick={() => onStartModal('grab')}>
          <Move size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Rotate (R)">
        <Button variant="icon" size="none" onClick={() => onStartModal('rotate')}>
          <RotateCw size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Scale (S)">
        <Button variant="icon" size="none" onClick={() => onStartModal('scale')}>
          <Maximize size={14} />
        </Button>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tooltip content="Frame selected (F)">
        <Button variant="icon" size="none" onClick={onFrameSelected}>
          <Focus size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Grid (.)">
        <button
          type="button"
          onClick={toggleGrid}
          aria-pressed={showGrid}
          className={
            'flex h-7 w-7 items-center justify-center rounded-sm border ' +
            (showGrid
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-transparent text-text-mid hover:bg-bg-3')
          }
        >
          <Grid3x3 size={13} />
        </button>
      </Tooltip>
      <Tooltip content="Wireframe (,)">
        <button
          type="button"
          onClick={toggleWireframe}
          aria-pressed={showWireframe}
          className={
            'flex h-7 w-7 items-center justify-center rounded-sm border ' +
            (showWireframe
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-transparent text-text-mid hover:bg-bg-3')
          }
        >
          <Eye size={13} />
        </button>
      </Tooltip>
      <div className="flex-1" />
      <Tooltip content="Undo (Ctrl+Z)">
        <Button variant="icon" size="none" onClick={() => room.undo.undo()}>
          <Undo2 size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Redo (Ctrl+Shift+Z)">
        <Button variant="icon" size="none" onClick={() => room.undo.redo()}>
          <Redo2 size={14} />
        </Button>
      </Tooltip>
      {selection.length > 0 && (
        <Tooltip content="Delete (X)">
          <Button
            variant="icon"
            size="none"
            onClick={() => {
              deleteObjects(room.slate, selection);
              clearSelection();
            }}
          >
            <Trash2 size={14} />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

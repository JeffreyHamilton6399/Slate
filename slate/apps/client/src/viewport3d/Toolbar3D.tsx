/**
 * Top toolbar for the 3D viewport: mode toggle, add menu, transform tool
 * triggers, snap/space toggles, undo/redo.
 */

import {
  Box,
  Axis3d,
  Camera,
  ChevronDown,
  Plus,
  Move,
  RotateCw,
  Maximize,
  Grid3x3,
  Undo2,
  Redo2,
  Trash2,
  Focus,
  ArrowUpFromLine,
  Shrink,
  Diamond,
  Scissors,
  Copy,
  Clapperboard,
  Blend,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/DropdownMenu';
import {
  deleteObjects,
  dropToFloor,
  duplicateObjects,
  joinObjects,
  mirrorObjects,
} from './scene';
import { addSceneObject, LIGHT_ITEMS, MESH_ITEMS } from './AddObjectMenu';
import { runEditOp, type EditOp } from './editModeTools';
import type { SlateRoom } from '../sync/provider';
import { useScene3DStore, type GizmoMode, type ShadingMode } from './store';
import type { SceneSnapshot } from './scene';
import { useIsMobile } from '../workspace/useMediaQuery';

interface Toolbar3DProps {
  room: SlateRoom;
  snapshot: SceneSnapshot;
  onStartModal: (k: 'grab' | 'rotate' | 'scale') => void;
  onStartMeshModal: (
    k: 'grab' | 'extrude' | 'rotate' | 'scale' | 'bevel' | 'inset' | 'loop-cut',
  ) => void;
  onFrameSelected: () => void;
  onRenderImage: () => void;
  onRenderAnimation: () => void;
  rendering: boolean;
}

/** The single transform-tool button cycles Move → Rotate → Scale → All. */
const GIZMO_ICON: Record<Exclude<GizmoMode, null>, typeof Box> = {
  translate: Move,
  rotate: RotateCw,
  scale: Maximize,
  all: Axis3d,
};
const GIZMO_LABEL: Record<Exclude<GizmoMode, null>, string> = {
  translate: 'Move',
  rotate: 'Rotate',
  scale: 'Scale',
  all: 'All',
};

/** Viewport shading cycles through Blender's four modes on one button. */
const SHADING_ORDER: ShadingMode[] = ['wireframe', 'solid', 'material', 'rendered'];
const SHADING_LABEL: Record<ShadingMode, string> = {
  wireframe: 'Wire',
  solid: 'Solid',
  material: 'Mat',
  rendered: 'Rend',
};

/** The everyday modeling tools stay one click away as icons… */
const PRIMARY_EDIT_OPS: { op: EditOp; label: string; Icon: typeof Box }[] = [
  { op: 'extrude', label: 'Extrude (E)', Icon: ArrowUpFromLine },
  { op: 'inset', label: 'Inset (I)', Icon: Shrink },
  { op: 'bevel', label: 'Bevel (Ctrl+B)', Icon: Diamond },
  { op: 'loop-cut', label: 'Loop cut (Ctrl+R)', Icon: Scissors },
  { op: 'subdivide', label: 'Subdivide', Icon: Grid3x3 },
];

/** …the rest sort into a Mesh menu, grouped Blender-style. */
const MESH_MENU: ({ op: EditOp; label: string } | 'divider')[] = [
  { op: 'smooth', label: 'Smooth vertices' },
  { op: 'fatten', label: 'Fatten (along normals)' },
  { op: 'shrink', label: 'Shrink (along normals)' },
  { op: 'shear', label: 'Shear' },
  { op: 'to-sphere', label: 'To Sphere' },
  'divider',
  { op: 'duplicate-faces', label: 'Duplicate faces' },
  { op: 'rip-verts', label: ' Rip verts' },
  { op: 'fill', label: 'Fill face from verts (F)' },
  { op: 'merge', label: 'Merge verts (M)' },
  { op: 'triangulate', label: 'Triangulate' },
  'divider',
  { op: 'mirror-x', label: 'Mirror X' },
  { op: 'mirror-y', label: 'Mirror Y' },
  { op: 'mirror-z', label: 'Mirror Z' },
  'divider',
  { op: 'flip-normals', label: 'Flip normals' },
  { op: 'recalc-normals', label: 'Recalculate normals' },
  'divider',
  { op: 'delete-faces', label: 'Delete faces (X)' },
  { op: 'delete-verts', label: 'Delete vertices' },
];

const MIRROR_AXES = ['x', 'y', 'z'] as const;

/** Shared toolbar dispatch: bevel/inset/loop-cut and (face) extrude run as
 *  modal tools that track the mouse and confirm on click; the rest apply
 *  instantly. */
function runToolbarEditOp(
  room: SlateRoom,
  op: EditOp,
  onStartMeshModal: (
    k: 'grab' | 'extrude' | 'rotate' | 'scale' | 'bevel' | 'inset' | 'loop-cut',
  ) => void,
): void {
  const store = useScene3DStore.getState();
  const id = store.selection[0];
  if (!id) return;
  const { faces, verts } = store.editSelection;
  if (op === 'bevel' || op === 'inset' || op === 'loop-cut') {
    onStartMeshModal(op);
    return;
  }
  if (op === 'extrude' && faces.length > 0) {
    onStartMeshModal('extrude');
    return;
  }
  runEditOp(op, { room, objectId: id, faces, verts });
}

export function Toolbar3D({
  room,
  snapshot,
  onStartModal,
  onStartMeshModal,
  onFrameSelected,
  onRenderImage,
  onRenderAnimation,
  rendering,
}: Toolbar3DProps) {
  const editorMode = useScene3DStore((s) => s.editorMode);
  const setEditorMode = useScene3DStore((s) => s.setEditorMode);
  const selectMode = useScene3DStore((s) => s.selectMode);
  const setSelectMode = useScene3DStore((s) => s.setSelectMode);
  const showGrid = useScene3DStore((s) => s.showGrid);
  const shading = useScene3DStore((s) => s.shading);
  const setShading = useScene3DStore((s) => s.setShading);
  const gizmo = useScene3DStore((s) => s.gizmo);
  const cycleGizmo = useScene3DStore((s) => s.cycleGizmo);
  const space = useScene3DStore((s) => s.space);
  const setSpace = useScene3DStore((s) => s.setSpace);
  const pivot = useScene3DStore((s) => s.pivot);
  const setPivot = useScene3DStore((s) => s.setPivot);
  const toggleGrid = useScene3DStore((s) => s.toggleGrid);
  const selection = useScene3DStore((s) => s.selection);
  const clearSelection = useScene3DStore((s) => s.clearSelection);
  const setSelection = useScene3DStore((s) => s.setSelection);
  const isMobile = useIsMobile();

  return (
    <div className="absolute left-2 right-2 top-2 z-10 flex items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-bg-2/95 px-2 py-1 shadow-lg backdrop-blur [&>*]:shrink-0">
      {/* Single toggle button: click to flip Object ↔ Edit (Tab also works).
 *          One button, not two — shows the CURRENT mode, click to switch. */}
      <Tooltip content={`Mode: ${editorMode} — click to toggle (Tab)`}>
        <button
          type="button"
          aria-label={`Mode: ${editorMode} — click to toggle`}
          aria-pressed={editorMode === 'edit'}
          onClick={() => setEditorMode(editorMode === 'object' ? 'edit' : 'object')}
          className="w-16 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-center text-[10px] font-mono uppercase tracking-wider text-accent hover:bg-accent/20"
        >
          {editorMode === 'object' ? 'Object' : 'Edit'}
        </button>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border" />
      {/* View settings live left of the mode tools so they never scroll out
          of reach when a mode adds more buttons. */}
      <Tooltip content={`Shading: ${shading} — click to cycle (Z wire · Shift+Z rendered)`}>
        <button
          type="button"
          aria-label="Cycle viewport shading"
          onClick={() =>
            setShading(SHADING_ORDER[(SHADING_ORDER.indexOf(shading) + 1) % SHADING_ORDER.length]!)
          }
          className="w-14 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-center text-[10px] font-mono uppercase tracking-wider text-accent hover:bg-accent/20"
        >
          {SHADING_LABEL[shading]}
        </button>
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
      {/* Smooth / flat shading for the primary selected mesh — Blender keeps
          this one click away in the header, not buried in the N-panel. */}
      {(() => {
        const primary = selection[0]
          ? snapshot.objects.find((o) => o.id === selection[0])
          : undefined;
        const isMesh = Boolean(primary?.meshId);
        const smooth = Boolean(primary?.smooth);
        return (
          <Tooltip
            content={
              !isMesh
                ? 'Smooth shading — select a mesh'
                : smooth
                  ? 'Shading: smooth (click for flat)'
                  : 'Shading: flat (click for smooth)'
            }
          >
            <button
              type="button"
              disabled={!isMesh}
              aria-pressed={smooth}
              aria-label="Toggle smooth / flat shading"
              onClick={() => {
                if (!primary?.id) return;
                const yo = room.slate.scene3dObjects().get(primary.id);
                if (yo && yo.get('meshId')) yo.set('smooth', !smooth);
              }}
              className={
                'flex h-7 w-7 items-center justify-center rounded-sm border ' +
                (!isMesh
                  ? 'border-transparent text-text-mid opacity-40'
                  : smooth
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-transparent text-text-mid hover:bg-bg-3')
              }
            >
              <Blend size={14} />
            </button>
          </Tooltip>
        );
      })()}
      <div className="mx-1 h-5 w-px bg-border" />
      {editorMode === 'object' ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Plus size={13} />
                <span className="ml-1">Add</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {/* addSceneObject selects the new object so transform + material
                  controls target it immediately (Blender selects on add). */}
              {MESH_ITEMS.map(({ type, label, Icon }) => (
                <DropdownMenuItem key={type} onSelect={() => addSceneObject(room, { mesh: type })}>
                  <Icon size={12} />
                  <span className="ml-2">{label}</span>
                </DropdownMenuItem>
              ))}
              {LIGHT_ITEMS.map(({ kind, label, Icon }) => (
                <DropdownMenuItem key={kind} onSelect={() => addSceneObject(room, { light: kind })}>
                  <Icon size={12} />
                  <span className="ml-2">{label} light</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => addSceneObject(room, { empty: true })}>
                <Axis3d size={12} />
                <span className="ml-2">Empty</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mx-1 h-5 w-px bg-border" />
          {/* Single transform-tool button: click to cycle the gizmo through
              Move → Rotate → Scale → All (all three handles at once), the same
              way shading and select-mode cycle on one button. Keyboard G/R/S
              stay modal. */}
          {(() => {
            const g = (gizmo ?? 'translate') as Exclude<GizmoMode, null>;
            const Icon = GIZMO_ICON[g];
            return (
              <Tooltip content={`Transform: ${GIZMO_LABEL[g]} — click to cycle (Move · Rotate · Scale · All)`}>
                <button
                  type="button"
                  aria-label={`Transform tool: ${GIZMO_LABEL[g]} — click to cycle`}
                  onClick={() => cycleGizmo()}
                  className="flex h-7 items-center gap-1 rounded-sm border border-accent/60 bg-accent/15 px-1.5 text-accent hover:bg-accent/25"
                >
                  <Icon size={14} />
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    {GIZMO_LABEL[g]}
                  </span>
                </button>
              </Tooltip>
            );
          })()}
          <Tooltip content={`Transform orientation: ${space} — click to toggle (World ↔ Local)`}>
            <button
              type="button"
              aria-label="Toggle transform orientation"
              onClick={() => setSpace(space === 'world' ? 'local' : 'world')}
              className="w-12 rounded-sm border border-border px-1.5 py-0.5 text-center text-[10px] font-mono uppercase tracking-wider text-text-mid hover:bg-bg-3"
            >
              {space === 'world' ? 'Global' : 'Local'}
            </button>
          </Tooltip>
          {/* Pivot point setting (Blender's pivot dropdown) — cycle:
              median → cursor → individual → active → median. */}
          <Tooltip content={`Pivot point: ${pivot} — click to cycle`}>
            <button
              type="button"
              aria-label={`Pivot point: ${pivot}`}
              onClick={() =>
                setPivot(
                  pivot === 'median'
                    ? 'cursor'
                    : pivot === 'cursor'
                      ? 'individual'
                      : pivot === 'individual'
                        ? 'active'
                        : 'median',
                )
              }
              className="w-20 rounded-sm border border-border px-1.5 py-0.5 text-center text-[10px] font-mono uppercase tracking-wider text-text-mid hover:bg-bg-3"
            >
              {pivot === 'median' ? 'Median' : pivot === 'cursor' ? 'Cursor' : pivot === 'individual' ? 'Indiv.' : 'Active'}
            </button>
          </Tooltip>
          <Tooltip content={selection.length ? 'Duplicate (Shift+D)' : 'Duplicate — select an object'}>
            <Button
              variant="icon"
              size="none"
              disabled={selection.length === 0}
              className={`h-7 w-7 p-0 ${selection.length === 0 ? 'opacity-40' : ''}`}
              onClick={() => {
                if (selection.length === 0) return;
                const copies = duplicateObjects(room.slate, selection);
                if (copies.length) {
                  setSelection(copies);
                  // Grab the copies so they follow the mouse, like Blender.
                  requestAnimationFrame(() => onStartModal('grab'));
                }
              }}
            >
              <Copy size={14} />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={selection.length === 0}
                aria-label="Object operations"
              >
                <span>Object</span>
                <ChevronDown size={11} className="ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                disabled={selection.length < 2}
                onSelect={() => {
                  const joined = joinObjects(room.slate, selection);
                  if (joined) setSelection([joined]);
                }}
              >
                Join (Ctrl+J)
              </DropdownMenuItem>
              {MIRROR_AXES.map((axis) => (
                <DropdownMenuItem
                  key={axis}
                  onSelect={() => mirrorObjects(room.slate, selection, axis)}
                >
                  Mirror {axis.toUpperCase()}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => dropToFloor(room.slate, selection)}>
                Drop to floor
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        // Edit mode: select-mode switcher + mesh operations.
        <>
          {/* Single cycle button for vert/edge/face select mode (like the
              shading cycle button) — click to switch to the next mode. */}
          <Tooltip content={`Select mode: ${selectMode} — click to cycle (1/2/3)`}>
            <button
              type="button"
              aria-label={`Select mode: ${selectMode}`}
              onClick={() =>
                setSelectMode(
                  selectMode === 'vertex' ? 'edge' : selectMode === 'edge' ? 'face' : 'vertex',
                )
              }
              className="w-14 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-center text-[10px] font-mono uppercase tracking-wider text-accent hover:bg-accent/20"
            >
              {selectMode === 'vertex' ? 'Vert' : selectMode === 'edge' ? 'Edge' : 'Face'}
            </button>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border" />
          {PRIMARY_EDIT_OPS.map(({ op, label, Icon }) => (
            <Tooltip key={op} content={selection.length === 1 ? label : `${label} — select one object`}>
              <Button
                variant="icon"
                size="none"
                disabled={selection.length !== 1}
                className={`h-7 w-7 p-0 ${selection.length !== 1 ? 'opacity-40' : ''}`}
                onClick={() => runToolbarEditOp(room, op, onStartMeshModal)}
              >
                <Icon size={14} />
              </Button>
            </Tooltip>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={selection.length !== 1}
                aria-label="Mesh operations"
              >
                <span>Mesh</span>
                <ChevronDown size={11} className="ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {MESH_MENU.map((item, i) =>
                item === 'divider' ? (
                  <div key={`div-${i}`} className="my-1 h-px bg-border" />
                ) : (
                  <DropdownMenuItem
                    key={item.op}
                    onSelect={() => runToolbarEditOp(room, item.op, onStartMeshModal)}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <div className="mx-1 h-5 w-px bg-border" />
      <Tooltip content="Frame selected (F)">
        <Button variant="icon" size="none" className="h-7 w-7 p-0" onClick={onFrameSelected}>
          <Focus size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Render image — saves the viewport as PNG (Numpad 0 looks through a camera first)">
        <Button variant="icon" size="none" className="h-7 w-7 p-0" onClick={onRenderImage} aria-label="Render image">
          <Camera size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Render animation — plays the timeline through the camera and saves an MP4 video">
        <Button
          variant="icon"
          size="none"
          className={`h-7 w-7 p-0 ${rendering ? 'text-danger' : ''}`}
          onClick={onRenderAnimation}
          disabled={rendering}
          aria-label="Render animation"
        >
          <Clapperboard size={14} />
        </Button>
      </Tooltip>
      {/* On mobile the spacer pushes undo/redo/delete off-screen, so skip it
          there — the toolbar already scrolls horizontally, and a flex-1 spacer
          inside a scroll strip would just inflate the scroll width. */}
      {!isMobile && <div className="flex-1" />}
      <Tooltip content="Undo (Ctrl+Z)">
        <Button variant="icon" size="none" className="h-7 w-7 p-0" onClick={() => room.undo.undo()}>
          <Undo2 size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="Redo (Ctrl+Shift+Z)">
        <Button variant="icon" size="none" className="h-7 w-7 p-0" onClick={() => room.undo.redo()}>
          <Redo2 size={14} />
        </Button>
      </Tooltip>
      {selection.length > 0 && (
        <Tooltip content="Delete (X)">
          <Button
            variant="icon"
            size="none"
            className="h-7 w-7 p-0"
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

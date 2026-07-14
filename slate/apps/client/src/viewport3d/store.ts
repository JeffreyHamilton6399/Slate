/**
 * 3D viewport local UI state — selection, edit mode, sub-element mode,
 * active modal tool, snap settings.
 */
import { create } from 'zustand';

export type Editor3DMode = 'object' | 'edit';
export type SelectMode = 'vertex' | 'edge' | 'face';

export type ModalTool =
  | null
  | 'grab'
  | 'rotate'
  | 'scale'
  | 'extrude'
  | 'inset'
  | 'bevel'
  | 'loop-cut'
  | 'knife';

/** Persistent transform gizmo shown on the selection (Blender's active tool).
 *  'all' shows move + rotate + scale handles at once (combined gizmo). */
export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'all' | null;

/** Order the single toolbar button cycles through (last = combined). */
export const GIZMO_CYCLE: Exclude<GizmoMode, null>[] = ['translate', 'rotate', 'scale', 'all'];

export type AxisLock = null | 'x' | 'y' | 'z';
export type SpaceMode = 'world' | 'local';

/** Blender's transform pivot point modes:
 *  median = center of selection's bounding box,
 *  cursor = the 3D cursor (origin for now),
 *  individual = each object/element rotates around its own center,
 *  active = the active (last-selected) object/element. */
export type PivotMode = 'median' | 'cursor' | 'individual' | 'active';

/** Blender's viewport shading modes: wireframe / solid / material preview / rendered. */
export type ShadingMode = 'wireframe' | 'solid' | 'material' | 'rendered';

interface Scene3DState {
  selection: string[];
  /** When in edit mode, vertex/edge/face indices into selected object. */
  editSelection: { verts: number[]; edges: number[]; faces: number[] };
  editorMode: Editor3DMode;
  selectMode: SelectMode;
  modal: { tool: ModalTool; axis: AxisLock; preview: number };
  gizmo: GizmoMode;
  /** True while the TransformControls gizmo is being dragged — suppresses
   *  animation overrides on the dragged object so the live base-transform
   *  edit is visible (not masked by the sampled pose). */
  gizmoDragging: boolean;
  space: SpaceMode;
  /** Transform pivot point (Blender's pivot mode dropdown). */
  pivot: PivotMode;
  showGrid: boolean;
  /** Timeline playhead (seconds), duration, playback + preview flags. */
  animTime: number;
  animDuration: number;
  animPlaying: boolean;
  /** True while scrubbing/playing — the viewport shows sampled poses. */
  animPreview: boolean;
  /** Camera being looked through (Numpad 0); orbit/fly/pan exits the view. */
  viewingCameraId: string | null;
  /** True while recording an animation — viewport aids (camera glyphs, gizmo,
   *  grid) are hidden so they don't appear in the captured video. */
  rendering: boolean;
  /** Asset picked in the Assets panel — Properties edits it (Blender-like). */
  selectedAssetId: string | null;
  /** First-person fly navigation active (MMB held). Suspends shortcuts. */
  flying: boolean;
  /** Fly-mode movement speed in units/s (mouse wheel adjusts). */
  flySpeed: number;
  shading: ShadingMode;
  /** Shading mode to return to when a wireframe/rendered toggle is untoggled. */
  prevShading: ShadingMode;
  snap: { translation: boolean; rotation: boolean; scale: boolean };

  setSelection: (ids: string[]) => void;
  addSelection: (id: string) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setEditSelection: (s: { verts?: number[]; edges?: number[]; faces?: number[] }) => void;
  setEditorMode: (m: Editor3DMode) => void;
  setSelectMode: (m: SelectMode) => void;
  setModal: (m: { tool: ModalTool; axis?: AxisLock; preview?: number }) => void;
  /** Set the active transform tool (Blender-style: sticky, no toggle). The
   *  G/R/S keyboard shortcuts run a one-shot modal preview and then restore
   *  this active tool when confirmed/cancelled. */
  setGizmo: (g: GizmoMode) => void;
  /** Advance the single transform-tool button to the next mode in GIZMO_CYCLE. */
  cycleGizmo: () => void;
  setGizmoDragging: (v: boolean) => void;
  setAnimTime: (t: number) => void;
  setAnimDuration: (d: number) => void;
  setAnimPlaying: (v: boolean) => void;
  setAnimPreview: (v: boolean) => void;
  setViewingCamera: (id: string | null) => void;
  setRendering: (v: boolean) => void;
  setSelectedAsset: (id: string | null) => void;
  setSpace: (m: SpaceMode) => void;
  setPivot: (p: PivotMode) => void;
  setFlying: (v: boolean) => void;
  setFlySpeed: (v: number) => void;
  toggleGrid: () => void;
  setShading: (m: ShadingMode) => void;
  /** Z in Blender: flip between wireframe and the previous shaded mode. */
  toggleWireframe: () => void;
  /** Shift+Z-ish: flip between rendered and the previous mode. */
  toggleRendered: () => void;
  setSnap: (s: Partial<Scene3DState['snap']>) => void;
}

export const useScene3DStore = create<Scene3DState>((set) => ({
  selection: [],
  editSelection: { verts: [], edges: [], faces: [] },
  editorMode: 'object',
  selectMode: 'vertex',
  modal: { tool: null, axis: null, preview: 0 },
  gizmo: 'translate',
  gizmoDragging: false,
  animTime: 0,
  animDuration: 5,
  animPlaying: false,
  animPreview: false,
  viewingCameraId: null,
  rendering: false,
  selectedAssetId: null,
  space: 'world',
  pivot: 'median',
  showGrid: true,
  flying: false,
  flySpeed: 6,
  shading: 'material',
  prevShading: 'material',
  snap: { translation: false, rotation: false, scale: false },

  // Changing the object selection invalidates any sub-element selection and
  // returns Properties to the object (away from an asset).
  setSelection: (selection) =>
    set({ selection, editSelection: { verts: [], edges: [], faces: [] }, selectedAssetId: null }),
  addSelection: (id) =>
    set((s) => (s.selection.includes(id) ? s : { selection: [...s.selection, id] })),
  toggleSelection: (id) =>
    set((s) => ({
      selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
    })),
  clearSelection: () => set({ selection: [], editSelection: { verts: [], edges: [], faces: [] } }),
  setEditSelection: (s) =>
    set((state) => ({
      editSelection: {
        verts: s.verts ?? state.editSelection.verts,
        edges: s.edges ?? state.editSelection.edges,
        faces: s.faces ?? state.editSelection.faces,
      },
    })),
  setEditorMode: (editorMode) =>
    set({ editorMode, editSelection: { verts: [], edges: [], faces: [] } }),
  setSelectMode: (selectMode) => set({ selectMode }),
  setModal: (m) =>
    set((s) => ({
      modal: {
        tool: m.tool,
        axis: m.axis ?? s.modal.axis,
        preview: m.preview ?? 0,
      },
    })),
  setGizmo: (g) => set({ gizmo: g }),
  cycleGizmo: () =>
    set((s) => {
      const i = GIZMO_CYCLE.indexOf(s.gizmo as Exclude<GizmoMode, null>);
      return { gizmo: GIZMO_CYCLE[(i + 1) % GIZMO_CYCLE.length]! };
    }),
  setGizmoDragging: (gizmoDragging) => set({ gizmoDragging }),
  setAnimTime: (animTime) => set({ animTime: Math.max(0, animTime) }),
  setAnimDuration: (d) =>
    set((s) => ({
      animDuration: Math.max(0.5, Math.min(600, d)),
      animTime: Math.min(s.animTime, Math.max(0.5, Math.min(600, d))),
    })),
  setAnimPlaying: (animPlaying) =>
    set((s) => ({ animPlaying, animPreview: animPlaying || s.animPreview })),
  setAnimPreview: (animPreview) => set({ animPreview }),
  setViewingCamera: (viewingCameraId) => set({ viewingCameraId }),
  setRendering: (rendering) => set({ rendering }),
  setSelectedAsset: (selectedAssetId) => set({ selectedAssetId }),
  setSpace: (space) => set({ space }),
  setPivot: (pivot) => set({ pivot }),
  setFlying: (flying) => set({ flying }),
  setFlySpeed: (flySpeed) => set({ flySpeed }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  setShading: (shading) =>
    set((s) => (shading === s.shading ? s : { shading, prevShading: s.shading })),
  toggleWireframe: () =>
    set((s) =>
      s.shading === 'wireframe'
        ? { shading: s.prevShading === 'wireframe' ? 'material' : s.prevShading, prevShading: 'wireframe' }
        : { shading: 'wireframe', prevShading: s.shading },
    ),
  toggleRendered: () =>
    set((s) =>
      s.shading === 'rendered'
        ? { shading: s.prevShading === 'rendered' ? 'material' : s.prevShading, prevShading: 'rendered' }
        : { shading: 'rendered', prevShading: s.shading },
    ),
  setSnap: (s) => set((state) => ({ snap: { ...state.snap, ...s } })),
}));

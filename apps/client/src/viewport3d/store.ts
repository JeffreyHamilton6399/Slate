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

export type AxisLock = null | 'x' | 'y' | 'z';
export type SpaceMode = 'world' | 'local';

interface Scene3DState {
  selection: string[];
  /** When in edit mode, vertex/edge/face indices into selected object. */
  editSelection: { verts: number[]; edges: number[]; faces: number[] };
  editorMode: Editor3DMode;
  selectMode: SelectMode;
  modal: { tool: ModalTool; axis: AxisLock; preview: number };
  space: SpaceMode;
  showGrid: boolean;
  showWireframe: boolean;
  snap: { translation: boolean; rotation: boolean; scale: boolean };

  setSelection: (ids: string[]) => void;
  addSelection: (id: string) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setEditSelection: (s: { verts?: number[]; edges?: number[]; faces?: number[] }) => void;
  setEditorMode: (m: Editor3DMode) => void;
  setSelectMode: (m: SelectMode) => void;
  setModal: (m: { tool: ModalTool; axis?: AxisLock; preview?: number }) => void;
  setSpace: (m: SpaceMode) => void;
  toggleGrid: () => void;
  toggleWireframe: () => void;
  setSnap: (s: Partial<Scene3DState['snap']>) => void;
}

export const useScene3DStore = create<Scene3DState>((set) => ({
  selection: [],
  editSelection: { verts: [], edges: [], faces: [] },
  editorMode: 'object',
  selectMode: 'vertex',
  modal: { tool: null, axis: null, preview: 0 },
  space: 'world',
  showGrid: true,
  showWireframe: false,
  snap: { translation: false, rotation: false, scale: false },

  setSelection: (selection) => set({ selection }),
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
  setEditorMode: (editorMode) => set({ editorMode }),
  setSelectMode: (selectMode) => set({ selectMode }),
  setModal: (m) =>
    set((s) => ({
      modal: {
        tool: m.tool,
        axis: m.axis ?? s.modal.axis,
        preview: m.preview ?? 0,
      },
    })),
  setSpace: (space) => set({ space }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleWireframe: () => set((s) => ({ showWireframe: !s.showWireframe })),
  setSnap: (s) => set((state) => ({ snap: { ...state.snap, ...s } })),
}));

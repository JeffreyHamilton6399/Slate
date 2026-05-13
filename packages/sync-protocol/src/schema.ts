/**
 * Pure TypeScript types describing the Slate document schema.
 * The shape stored in Y.Doc mirrors these types but uses Y.Map/Y.Array
 * containers for collaborative merge; helpers in the client map between
 * the two.
 */

export type DocMode = '2d' | '3d';
export type BoardVisibility = 'public' | 'private';

export interface BoardMeta {
  /** Stable peer id of the creator (permanent host). */
  createdBy: string;
  createdAt: number;
  name: string;
  topic: string;
  visibility: BoardVisibility;
  mode: DocMode;
  /** Paper / background color. */
  paper: string;
  /** Current acting host (creator unless transferred). */
  hostId: string;
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'line' | 'arrow' | 'text';

export interface Shape {
  id: string;
  kind: ShapeKind;
  layerId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  /** Only used when kind === 'text'. */
  text?: string;
  fontSize?: number;
  createdAt: number;
  authorId: string;
}

export type StrokeKind = 'pen' | 'highlighter' | 'eraser';

export interface Stroke {
  id: string;
  kind: StrokeKind;
  layerId: string;
  color: string;
  size: number;
  opacity: number;
  /** Interleaved [x, y, pressure?] points. */
  points: number[];
  createdAt: number;
  authorId: string;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export type Object3DType =
  | 'folder'
  | 'mesh'
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'plane'
  | 'torus'
  | 'empty';

export interface Object3D {
  id: string;
  parentId: string | null;
  type: Object3DType;
  name: string;
  visible: boolean;
  transform: Transform;
  /** Reference to mesh data; null for folders/empties. */
  meshId: string | null;
  /** Reference to material; default if null. */
  materialId: string | null;
  /** Outliner collapsed state (folder only). */
  collapsed?: boolean;
  /** Smooth-shaded normals. */
  smooth?: boolean;
}

export interface Face {
  /** Vertex indices. Triangles or n-gons. */
  v: number[];
}

export interface MeshData {
  id: string;
  /** Interleaved [x,y,z,...] vertex positions. */
  vertices: number[];
  faces: Face[];
}

export type MaterialKind = 'pbr';

export interface Material {
  id: string;
  kind: MaterialKind;
  color: string;
  metalness: number;
  roughness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
}

export interface NoteItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface NoteSection {
  id: string;
  title: string;
  body: string;
  items: NoteItem[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
}

/** Server-side public-room registry info (also consumed by client). */
export interface RoomInfo {
  name: string;
  visibility: BoardVisibility;
  hostId: string;
  topic: string;
  mode: DocMode;
  createdAt: number;
  members: number;
}

/** Full plain-JS snapshot — useful for exports / golden tests. */
export interface SlateDocSnapshot {
  meta: BoardMeta;
  shapes: Record<string, Shape>;
  strokes: Record<string, Stroke>;
  layers: Layer[];
  scene3d: {
    objects: Record<string, Object3D>;
    meshes: Record<string, MeshData>;
    materials: Record<string, Material>;
  };
  notes: NoteSection[];
  chat: ChatMessage[];
}

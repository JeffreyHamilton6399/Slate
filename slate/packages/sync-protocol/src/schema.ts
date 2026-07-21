/**
 * Pure TypeScript types describing the Slate document schema.
 * The shape stored in Y.Doc mirrors these types but uses Y.Map/Y.Array
 * containers for collaborative merge; helpers in the client map between
 * the two.
 */

export type DocMode = '2d' | '3d' | 'audio' | 'doc' | 'code' | 'diagram';
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

export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'arrow'
  | 'text'
  | 'polygon'
  | 'star'
  | 'image'
  | 'heart'
  | 'cloud'
  | 'speech'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'parallelogram'
  | 'trapezoid'
  | 'cross';

/** 2D transform — position, rotation, scale, opacity (for animation). */
export interface Transform2D {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

/** A 2D transform keyframe at time `t` (seconds). */
export interface AnimKey2D {
  t: number;
  transform: Transform2D;
}

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
  /** Polygon vertex count / star point count (kind === 'polygon' | 'star'). */
  sides?: number;
  /** Image data URL (kind === 'image'). Kept small enough to sync. */
  src?: string;
  createdAt: number;
  authorId: string;
  /** 2D animation keyframes (Adobe Animate / After Effects style). */
  anim?: AnimKey2D[];
  /** Frame-based (cel) animation: the frame index this shape lives on. When
   *  set, the shape is only drawn on that frame in frame-animation mode.
   *  Undefined means "static" — shown on every frame. */
  frame?: number;
}

export type StrokeKind = 'pen' | 'highlighter' | 'eraser' | 'pencil' | 'marker' | 'calligraphy' | 'airbrush';

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
  /** Frame-based (cel) animation: the frame index this stroke lives on. When
   *  set, the stroke is only drawn on that frame in frame-animation mode.
   *  Undefined means "static" — shown on every frame. */
  frame?: number;
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
  | 'empty'
  | 'light'
  | 'camera';

export type LightKind = 'point' | 'sun' | 'spot' | 'hemisphere' | 'area';

/** Scene camera parameters (type === 'camera'). Looks along local -Y. */
export interface CameraData {
  fov: number;
}

export interface LightData {
  kind: LightKind;
  color: string;
  intensity: number;
  /** Point/spot falloff distance (0 = infinite). */
  distance: number;
  /** Spot cone angle in radians. */
  angle: number;
}

/** A transform keyframe at time `t` (seconds). */
export interface AnimKey {
  t: number;
  transform: Transform;
}

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
  /** Light parameters (type === 'light' only). */
  light?: LightData;
  /** Camera parameters (type === 'camera' only). */
  camera?: CameraData;
  /** Transform keyframes, sorted by time. */
  anim?: AnimKey[];
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

export type TextureKind =
  | 'none'
  | 'checker'
  | 'grid'
  | 'dots'
  | 'stripes'
  | 'bricks'
  | 'waves'
  | 'noise'
  | 'image';

/** Procedural texture — synced as parameters, rendered client-side.
 *  For 'image' kind, `src` holds a data URL. */
export interface MaterialTexture {
  kind: TextureKind;
  /** Pattern repeats per unit (box-projected UVs). */
  scale: number;
  /** Secondary pattern color; the base material color fills the rest. */
  color2: string;
  /** Image data URL when kind === 'image'. */
  src?: string;
}

export interface Material {
  id: string;
  kind: MaterialKind;
  color: string;
  metalness: number;
  roughness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  texture?: MaterialTexture;
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

// ── Diagram / whiteboard editor schema (Miro / Excalidraw-style) ────────────

/** A node in the diagram editor — a labelled shape placed on an infinite
 *  canvas. Connectors (edges) link nodes by id. Beyond the original four,
 *  the set now covers the common flowchart vocabulary: process/terminator
 *  (pill), decision (diamond), data (parallelogram), database (cylinder),
 *  preparation (hexagon), and a triangle. */
export type DiagramNodeShape =
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'note'
  | 'pill'
  | 'parallelogram'
  | 'hexagon'
  | 'cylinder'
  | 'triangle';

/** How a connector is drawn between its two node endpoints. */
export type DiagramEdgeRouting = 'straight' | 'curved' | 'elbow';

export interface DiagramNode {
  id: string;
  shape: DiagramNodeShape;
  /** Top-left position in board coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Label text drawn (and wrapped) inside the node. */
  text: string;
  /** Body fill color. */
  fill: string;
  /** Border + text color. */
  stroke: string;
  createdAt: number;
  authorId: string;
}

/** A directed connector between two nodes. Endpoints reference node ids and
 *  the line is routed to each node's border at render time. */
export interface DiagramEdge {
  id: string;
  /** Source node id. */
  from: string;
  /** Target node id (arrowhead end). */
  to: string;
  /** Optional label drawn at the midpoint. */
  label: string;
  /** Line color. */
  stroke: string;
  /** How the connector is routed. Optional for back-compat (absent = straight). */
  routing?: DiagramEdgeRouting;
  /** Draw the connector dashed. Optional for back-compat (absent = solid). */
  dashed?: boolean;
  createdAt: number;
  authorId: string;
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

// ── Audio editor schema (BandLab-style DAW) ─────────────────────────────────

/** A track lane in the audio editor. Each track has its own gain, pan, and
 *  effects chain. Clips are placed on tracks at specific times. */
export interface AudioTrack {
  id: string;
  name: string;
  color: string;
  /** Volume 0..1 (linear). 1 = unity gain. */
  volume: number;
  /** Pan -1 (left) .. 0 (center) .. 1 (right). */
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Track type — 'audio' = recorded/imported clips, 'midi' = MIDI (future). */
  kind: 'audio' | 'midi';
  /** Input source for recording: 'mic' | 'midi' | 'none'. 'midi' arms the
   *  track for instrument-take recording (notes captured to a MIDI clip). */
  input: 'mic' | 'midi' | 'none';
  /** Whether this track is armed for recording. */
  armed: boolean;
  /** Display order (0 = top). */
  order: number;
  /** 3-band channel EQ, gains in dB (-12..+12). Low shelf @ 200 Hz. Default 0. */
  eqLow?: number;
  /** Mid peaking band @ 1 kHz, dB (-12..+12). Default 0. */
  eqMid?: number;
  /** High shelf @ 4 kHz, dB (-12..+12). Default 0. */
  eqHigh?: number;
  /** Reverb send level 0..1 (post-EQ, into the shared room reverb). Default 0. */
  reverbSend?: number;
  /** Delay send level 0..1 (post-EQ, into the shared echo). Default 0. */
  delaySend?: number;
  /** Instrument preset ID for MIDI tracks (e.g. 'inst-grand-piano' or
   *  'soundfont-piano'). When set, MIDI clips on this track are rendered with
   *  the matching instrument — oscillator-based LiveInstrument for synth
   *  presets, or SoundfontInstrument for sample-backed IDs. */
  instrumentId?: string;
}

/** A single MIDI note event inside a MIDI clip. Times are in seconds relative
 *  to the clip's `start` on the timeline (so a clip placed at t=4 with a note
 *  whose `start` is 0.5 fires at t=4.5). */
export interface NoteEvent {
  /** MIDI note number (0-127). 60 = middle C. */
  midi: number;
  /** Note-on velocity, 0..1. */
  velocity: number;
  /** Start time in seconds (relative to clip start). */
  start: number;
  /** Held duration in seconds. */
  duration: number;
}

/** A clip on a track — a segment of audio placed at a specific time. */
export interface AudioClip {
  id: string;
  trackId: string;
  /** Start time in seconds (where the clip begins on the timeline). */
  start: number;
  /** Offset into the source audio (trim from the left, in seconds). */
  offset: number;
  /** Duration of the clip in seconds (may be shorter than the source). */
  duration: number;
  /** Key into the IndexedDB sample store (audio data is NOT in Yjs — too big).
   *  Use loadSamples(key) to get the Float32Array PCM data. */
  sampleKey: string;
  /** Sample rate of the source audio (e.g. 44100). */
  sampleRate: number;
  /** Number of channels (1 = mono, 2 = stereo). */
  channels: number;
  /** Clip name (usually the filename or "Recording"). */
  name: string;
  /** Color override (defaults to track color). */
  color: string;
  /** Fade in duration (seconds). */
  fadeIn: number;
  /** Fade out duration (seconds). */
  fadeOut: number;
  /** Clip gain 0..1.5 (linear), multiplied with the track volume. Default 1. */
  gain?: number;
  /** Clip pan -1 (left) .. 0 .. 1 (right), applied on top of the track pan. Default 0. */
  pan?: number;
  /** Mute just this clip without affecting the rest of the track. Default false. */
  mute?: boolean;
  /** Playback speed 0.25..4 — a pitch-preserving time-stretch (the engine
   *  cancels the playbackRate pitch side effect with a pitch-shift worklet).
   *  Default 1. */
  speed?: number;
  /** Pitch shift in cents (-1200..+1200). 0 = original pitch, +1200 = one
   *  octave up, -1200 = one octave down. Duration-preserving (applied via a
   *  granular pitch shifter, not detune). Stored in cents = semitones × 100.
   *  Default 0. */
  pitch?: number;
  /** High-pass filter cutoff in Hz. 20 (= bottom of hearing) means OFF.
   *  Default 20. */
  hpCutoff?: number;
  /** Low-pass filter cutoff in Hz. 20000 (= top of hearing) means OFF.
   *  Default 20000. */
  lpCutoff?: number;
  /** Clip type — 'audio' = PCM samples, 'midi' = note events. Defaults to
   *  'audio' for backward compatibility with clips created before MIDI support
   *  landed. A MIDI clip carries `notes` + `instrumentId` instead of (or in
   *  addition to) the sample-buffer fields. */
  kind?: 'audio' | 'midi';
  /** MIDI note events (only meaningful when kind === 'midi'). Each note's
   *  `start` is relative to the clip's `start` on the timeline. */
  notes?: NoteEvent[];
  /** Instrument ID for MIDI clips (which synth/soundfont preset to use).
   *  Falls back to the track's `instrumentId` when unset. */
  instrumentId?: string;
}

/** Transport state for the audio editor — synced via awareness (ephemeral). */
export interface AudioTransportState {
  /** Current playhead position in seconds. */
  position: number;
  /** Whether the transport is playing. */
  playing: boolean;
  /** Whether recording is active. */
  recording: boolean;
  /** Tempo in BPM. */
  bpm: number;
  /** Whether the metronome is on. */
  metronome: boolean;
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
  audio: {
    tracks: AudioTrack[];
    clips: AudioClip[];
    bpm: number;
  };
  notes: NoteSection[];
  chat: ChatMessage[];
  /** Diagram boards: nodes + connectors. Optional — absent on snapshots from
   *  older clients and non-diagram boards. */
  diagram?: {
    nodes: DiagramNode[];
    edges: DiagramEdge[];
  };
  /** Rich-text document ('doc' boards) as ProseMirror-shaped JSON — the
   *  y-prosemirror encoding of the doc:text fragment. Optional: absent on
   *  snapshots from older clients and non-doc boards. */
  docText?: unknown;
  /** 'code' boards: file list + per-file plain-text contents keyed by file
   *  id. Optional: absent on snapshots from older clients. */
  codeFiles?: {
    files: { id: string; name: string }[];
    contents: Record<string, string>;
  };
}

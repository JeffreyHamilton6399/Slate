import { z } from 'zod';
import {
  MAX_BOARD_NAME_LEN,
  MAX_CHAT_LEN,
  MAX_NAME_LEN,
  MAX_TOPIC_LEN,
} from './constants.js';

/** A hex / rgb-like color string. We allow a permissive shape; rendering
 *  code falls back to safe defaults if parsing fails. */
const colorString = z.string().min(1).max(64);

export const idSchema = z.string().min(1).max(120);

export const vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export const transformSchema = z.object({
  position: vec3Schema,
  rotation: vec3Schema,
  scale: vec3Schema,
});

export const boardMetaSchema = z.object({
  createdBy: idSchema,
  createdAt: z.number().int().nonnegative(),
  name: z.string().min(1).max(MAX_BOARD_NAME_LEN),
  topic: z.string().max(MAX_TOPIC_LEN),
  visibility: z.enum(['public', 'private']),
  mode: z.enum(['2d', '3d', 'audio', 'doc']),
  paper: colorString,
  hostId: idSchema,
});

export const layerSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: z.number().min(0).max(1),
});

export const transform2DSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.number().finite(),
  scaleX: z.number().finite(),
  scaleY: z.number().finite(),
  opacity: z.number().min(0).max(1),
});

export const shapeSchema = z.object({
  id: idSchema,
  kind: z.enum([
    'rect',
    'ellipse',
    'triangle',
    'line',
    'arrow',
    'text',
    'polygon',
    'star',
    'image',
    'heart',
    'cloud',
    'speech',
    'diamond',
    'pentagon',
    'hexagon',
    'parallelogram',
    'trapezoid',
    'cross',
  ]),
  layerId: idSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
  rotation: z.number().finite(),
  stroke: colorString,
  fill: colorString.nullable(),
  strokeWidth: z.number().min(0).max(200),
  strokeOpacity: z.number().min(0).max(1),
  text: z.string().max(5000).optional(),
  fontSize: z.number().min(1).max(512).optional(),
  sides: z.number().int().min(3).max(64).optional(),
  // Data-URL image payload. Must stay well under MAX_UPDATE_BYTES so one
  // image shape always fits in a single sync update.
  src: z.string().max(600_000).optional(),
  createdAt: z.number().int().nonnegative(),
  authorId: idSchema,
  anim: z
    .array(z.object({ t: z.number().min(0).max(3600), transform: transform2DSchema }))
    .max(500)
    .optional(),
  frame: z.number().int().min(0).max(100_000).optional(),
});

export const strokeSchema = z.object({
  id: idSchema,
  kind: z.enum(['pen', 'highlighter', 'eraser', 'pencil', 'marker', 'calligraphy', 'airbrush']),
  layerId: idSchema,
  color: colorString,
  size: z.number().min(0).max(200),
  opacity: z.number().min(0).max(1),
  points: z.array(z.number().finite()).max(200_000),
  createdAt: z.number().int().nonnegative(),
  authorId: idSchema,
  frame: z.number().int().min(0).max(100_000).optional(),
});

export const lightDataSchema = z.object({
  kind: z.enum(['point', 'sun', 'spot', 'hemisphere', 'area']),
  color: colorString,
  intensity: z.number().min(0).max(100),
  distance: z.number().min(0).max(1000),
  angle: z.number().min(0).max(Math.PI / 2),
});

export const object3DSchema = z.object({
  id: idSchema,
  parentId: idSchema.nullable(),
  type: z.enum([
    'folder',
    'mesh',
    'cube',
    'sphere',
    'cylinder',
    'cone',
    'plane',
    'torus',
    'empty',
    'light',
    'camera',
  ]),
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  transform: transformSchema,
  meshId: idSchema.nullable(),
  materialId: idSchema.nullable(),
  collapsed: z.boolean().optional(),
  smooth: z.boolean().optional(),
  light: lightDataSchema.optional(),
  camera: z.object({ fov: z.number().min(5).max(160) }).optional(),
  anim: z
    .array(z.object({ t: z.number().min(0).max(3600), transform: transformSchema }))
    .max(500)
    .optional(),
});

export const meshDataSchema = z.object({
  id: idSchema,
  vertices: z.array(z.number().finite()).max(3 * 500_000),
  faces: z
    .array(
      z.object({
        v: z.array(z.number().int().nonnegative()).min(3).max(64),
      }),
    )
    .max(500_000),
});

export const materialTextureSchema = z.object({
  kind: z.enum(['none', 'checker', 'grid', 'dots', 'stripes', 'bricks', 'waves', 'noise']),
  scale: z.number().min(0.1).max(32),
  color2: colorString,
});

export const materialSchema = z.object({
  id: idSchema,
  kind: z.literal('pbr'),
  color: colorString,
  metalness: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1),
  emissive: colorString,
  emissiveIntensity: z.number().min(0).max(10),
  opacity: z.number().min(0).max(1),
  texture: materialTextureSchema.optional(),
});

export const noteItemSchema = z.object({
  id: idSchema,
  text: z.string().max(2000),
  checked: z.boolean(),
});

export const noteSectionSchema = z.object({
  id: idSchema,
  title: z.string().max(200),
  body: z.string().max(20_000),
  items: z.array(noteItemSchema).max(500),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const chatMessageSchema = z.object({
  id: idSchema,
  authorId: idSchema,
  authorName: z.string().min(1).max(MAX_NAME_LEN),
  text: z.string().min(1).max(MAX_CHAT_LEN),
  createdAt: z.number().int().nonnegative(),
});

/** A safe display name: trim + length cap + strip control chars. */
export function sanitizeDisplayName(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_NAME_LEN);
}

/** Sanitize chat text: collapse runs of whitespace, strip controls. */
export function sanitizeChatText(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trimEnd()
    .slice(0, MAX_CHAT_LEN);
}

// ── Audio editor schema (BandLab-style DAW) ─────────────────────────────────

/** A single MIDI note event inside a MIDI clip. Times are in seconds relative
 *  to the clip's `start` on the timeline. */
export const noteEventSchema = z.object({
  /** MIDI note number (0-127). 60 = middle C. */
  midi: z.number().int().min(0).max(127),
  /** Note-on velocity, 0..1. */
  velocity: z.number().min(0).max(1),
  /** Start time in seconds (relative to clip start). */
  start: z.number().min(0).max(3600),
  /** Held duration in seconds. */
  duration: z.number().min(0).max(3600),
});

/** AudioTrack zod validator — matches the AudioTrack interface in schema.ts.
 *  Optional fields default to undefined; the client (scene.ts readAudioTrack)
 *  applies runtime defaults when reading from Yjs. */
export const audioTrackSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  color: colorString,
  volume: z.number().min(0).max(1.5),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  solo: z.boolean(),
  kind: z.enum(['audio', 'midi']),
  input: z.enum(['mic', 'midi', 'none']),
  armed: z.boolean(),
  order: z.number().int().min(0),
  eqLow: z.number().min(-12).max(12).optional(),
  eqMid: z.number().min(-12).max(12).optional(),
  eqHigh: z.number().min(-12).max(12).optional(),
  reverbSend: z.number().min(0).max(1).optional(),
  delaySend: z.number().min(0).max(1).optional(),
  /** Instrument preset ID for MIDI tracks (e.g. 'inst-grand-piano'). */
  instrumentId: z.string().min(1).max(120).optional(),
});

/** AudioClip zod validator — matches the AudioClip interface in schema.ts.
 *  The `kind` field discriminates PCM-sample clips ('audio') from note-event
 *  clips ('midi'); the `notes` array is only meaningful when kind === 'midi'.
 *  Backward compatibility: clips written before MIDI support default to
 *  'audio' (rendered by readAudioClip). */
export const audioClipSchema = z.object({
  id: idSchema,
  trackId: idSchema,
  start: z.number().min(0).max(3600),
  offset: z.number().min(0).max(3600),
  duration: z.number().min(0).max(3600),
  sampleKey: z.string().min(0).max(200),
  sampleRate: z.number().int().min(1).max(192000),
  channels: z.number().int().min(1).max(2),
  name: z.string().min(1).max(120),
  color: colorString,
  fadeIn: z.number().min(0).max(60),
  fadeOut: z.number().min(0).max(60),
  gain: z.number().min(0).max(4).optional(),
  pan: z.number().min(-1).max(1).optional(),
  mute: z.boolean().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  pitch: z.number().min(-1200).max(1200).optional(),
  hpCutoff: z.number().min(20).max(20000).optional(),
  lpCutoff: z.number().min(20).max(20000).optional(),
  /** Clip type — 'audio' = PCM samples, 'midi' = note events. */
  kind: z.enum(['audio', 'midi']).optional(),
  /** MIDI note events (only when kind === 'midi'). Capped at 10k notes/clip
   *  to keep Yjs updates snappy — that's ~5 minutes of 32nd notes at 120 BPM. */
  notes: z.array(noteEventSchema).max(10_000).optional(),
  /** Instrument ID for MIDI clips (which synth preset to use). */
  instrumentId: z.string().min(1).max(120).optional(),
});


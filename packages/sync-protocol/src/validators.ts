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
  mode: z.enum(['2d', '3d']),
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

export const shapeSchema = z.object({
  id: idSchema,
  kind: z.enum(['rect', 'ellipse', 'triangle', 'line', 'arrow', 'text']),
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
  createdAt: z.number().int().nonnegative(),
  authorId: idSchema,
});

export const strokeSchema = z.object({
  id: idSchema,
  kind: z.enum(['pen', 'highlighter', 'eraser']),
  layerId: idSchema,
  color: colorString,
  size: z.number().min(0).max(200),
  opacity: z.number().min(0).max(1),
  points: z.array(z.number().finite()).max(200_000),
  createdAt: z.number().int().nonnegative(),
  authorId: idSchema,
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
  ]),
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  transform: transformSchema,
  meshId: idSchema.nullable(),
  materialId: idSchema.nullable(),
  collapsed: z.boolean().optional(),
  smooth: z.boolean().optional(),
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

export const materialSchema = z.object({
  id: idSchema,
  kind: z.literal('pbr'),
  color: colorString,
  metalness: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1),
  emissive: colorString,
  emissiveIntensity: z.number().min(0).max(10),
  opacity: z.number().min(0).max(1),
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

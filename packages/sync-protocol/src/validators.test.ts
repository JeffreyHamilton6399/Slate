/**
 * Sanity tests for the wire-level validators. These do not exhaustively
 * fuzz every shape but cover the most common malicious / malformed payloads
 * we want to reject at the boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  chatMessageSchema,
  sanitizeChatText,
  sanitizeDisplayName,
  shapeSchema,
  meshDataSchema,
} from './validators.js';
import { MAX_CHAT_LEN, MAX_NAME_LEN } from './constants.js';

describe('sanitizeDisplayName', () => {
  it('strips control chars and trims', () => {
    expect(sanitizeDisplayName('\u0000Alice\u001F  ')).toBe('Alice');
  });
  it('caps length', () => {
    const huge = 'x'.repeat(500);
    expect(sanitizeDisplayName(huge)).toHaveLength(MAX_NAME_LEN);
  });
});

describe('sanitizeChatText', () => {
  it('strips control characters but keeps newlines and tabs', () => {
    const v = sanitizeChatText('hello\nworld\t!');
    expect(v).toBe('hello\nworld\t!');
  });
  it('caps length', () => {
    const huge = 'x'.repeat(MAX_CHAT_LEN + 100);
    expect(sanitizeChatText(huge).length).toBeLessThanOrEqual(MAX_CHAT_LEN);
  });
});

describe('chatMessageSchema', () => {
  it('accepts a well-formed message', () => {
    const ok = chatMessageSchema.safeParse({
      id: 'chat-1',
      authorId: 'peer-1',
      authorName: 'Alice',
      text: 'hi',
      createdAt: Date.now(),
    });
    expect(ok.success).toBe(true);
  });
  it('rejects empty text', () => {
    const r = chatMessageSchema.safeParse({
      id: 'chat-1',
      authorId: 'peer-1',
      authorName: 'Alice',
      text: '',
      createdAt: Date.now(),
    });
    expect(r.success).toBe(false);
  });
  it('rejects oversized text', () => {
    const r = chatMessageSchema.safeParse({
      id: 'chat-1',
      authorId: 'peer-1',
      authorName: 'Alice',
      text: 'x'.repeat(MAX_CHAT_LEN + 1),
      createdAt: Date.now(),
    });
    expect(r.success).toBe(false);
  });
});

describe('shapeSchema', () => {
  it('accepts a valid rect', () => {
    const r = shapeSchema.safeParse({
      id: 'shape-1',
      kind: 'rect',
      layerId: 'layer-1',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      rotation: 0,
      stroke: '#fff',
      fill: '#000',
      strokeWidth: 1,
      strokeOpacity: 1,
      createdAt: Date.now(),
      authorId: 'peer-1',
    });
    expect(r.success).toBe(true);
  });
  it('rejects non-finite coords', () => {
    const r = shapeSchema.safeParse({
      id: 'shape-1',
      kind: 'rect',
      layerId: 'layer-1',
      x: Infinity,
      y: 0,
      w: 10,
      h: 10,
      rotation: 0,
      stroke: '#fff',
      fill: '#000',
      strokeWidth: 1,
      strokeOpacity: 1,
      createdAt: Date.now(),
      authorId: 'peer-1',
    });
    expect(r.success).toBe(false);
  });
});

describe('meshDataSchema', () => {
  it('rejects a face with too few vertices', () => {
    const r = meshDataSchema.safeParse({
      id: 'mesh-1',
      vertices: [0, 0, 0, 1, 1, 1],
      faces: [{ v: [0, 1] }],
    });
    expect(r.success).toBe(false);
  });
  it('rejects negative face indices', () => {
    const r = meshDataSchema.safeParse({
      id: 'mesh-1',
      vertices: [0, 0, 0, 1, 1, 1, 2, 2, 2],
      faces: [{ v: [0, 1, -1] }],
    });
    expect(r.success).toBe(false);
  });
});

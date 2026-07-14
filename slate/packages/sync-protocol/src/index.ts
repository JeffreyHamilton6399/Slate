/**
 * Slate sync protocol — shared Yjs schema, runtime validators, and message
 * types. Imported by both client and server so any change shows up as a
 * type error on both sides.
 */
export * from './schema.js';
export * from './validators.js';
export * from './awareness.js';
export * from './constants.js';

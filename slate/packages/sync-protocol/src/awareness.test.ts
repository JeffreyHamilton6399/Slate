/**
 * rosterKey decides which awareness changes are allowed to re-render the
 * workspace. Getting it wrong is invisible in a screenshot and expensive in
 * practice: too loose and a board with six people re-renders its whole tree a
 * hundred times a second; too tight and someone joins, leaves, or starts
 * talking without the roster noticing.
 */
import { describe, it, expect } from 'vitest';
import { makeAwarenessState, rosterKey, VOICE_ACTIVE_LEVEL } from './awareness.js';

const peer = (id: string, over: Partial<ReturnType<typeof makeAwarenessState>> = {}) =>
  makeAwarenessState({ id, name: id, color: '#7c6aff', joinedAt: 1000, ...over });

describe('rosterKey', () => {
  it('ignores movement — cursor, camera, playhead and selection', () => {
    const before = [
      peer('a', { cursor: { x: 1, y: 1 }, cam: { p: [0, 0, 0], t: [0, 0, 0] } }),
      peer('b', { audio: { pos: 1, playing: true }, selection: ['s1'] }),
    ];
    const after = [
      peer('a', { cursor: { x: 900, y: 40 }, cam: { p: [5, 6, 7], t: [1, 2, 3] } }),
      peer('b', { audio: { pos: 92, playing: true }, selection: ['s2', 's3'] }),
    ];
    expect(rosterKey(after)).toBe(rosterKey(before));
  });

  it('notices someone joining, leaving, or being renamed', () => {
    const one = [peer('a')];
    expect(rosterKey([peer('a'), peer('b')])).not.toBe(rosterKey(one));
    expect(rosterKey([])).not.toBe(rosterKey(one));
    expect(rosterKey([peer('a', { name: 'Alice' })])).not.toBe(rosterKey(one));
  });

  it('notices the host badge and voice presence', () => {
    const base = [peer('a')];
    expect(rosterKey([peer('a', { isHost: true })])).not.toBe(rosterKey(base));
    expect(rosterKey([peer('a', { inVoice: true })])).not.toBe(rosterKey(base));
  });

  it('tracks voice level only across the talking threshold', () => {
    const quiet = [peer('a', { voiceLevel: 0 })];
    // Wobble below the threshold: the speaking ring wouldn't change, so no
    // re-render should be spent on it.
    expect(rosterKey([peer('a', { voiceLevel: VOICE_ACTIVE_LEVEL })])).toBe(rosterKey(quiet));
    expect(rosterKey([peer('a', { voiceLevel: VOICE_ACTIVE_LEVEL + 0.01 })])).not.toBe(
      rosterKey(quiet),
    );
  });

  it('notices a peer entering or leaving the 3D and audio editors', () => {
    const base = [peer('a')];
    expect(rosterKey([peer('a', { cam: { p: [0, 0, 0], t: [0, 0, 0] } })])).not.toBe(
      rosterKey(base),
    );
    expect(rosterKey([peer('a', { audio: { pos: 0, playing: false } })])).not.toBe(
      rosterKey(base),
    );
  });

  it('is order-independent — a reconnect reshuffles the awareness map', () => {
    const a = peer('a');
    const b = peer('b');
    expect(rosterKey([b, a])).toBe(rosterKey([a, b]));
  });
});

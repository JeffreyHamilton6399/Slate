/**
 * Awareness payload — ephemeral, broadcast at high frequency, never persisted.
 * Stored per-client in Yjs Awareness with `setLocalStateField`.
 */
export interface AwarenessState {
  /** Stable peer id. */
  id: string;
  /** Sanitized display name. */
  name: string;
  /** Assigned cursor color (hex). */
  color: string;
  /** Active tool name (2D or 3D). */
  tool: string;
  /** World-space pointer position (board coordinates). null = off-canvas. */
  cursor: { x: number; y: number } | null;
  /** 3D camera pose (position + look-at target) for viewport presence. */
  cam: { p: [number, number, number]; t: [number, number, number] } | null;
  /** Currently selected ids (2D shape/stroke ids OR 3D object ids). */
  selection: string[];
  /** Voice activity level 0..1 for talking indicator. */
  voiceLevel: number;
  /** Whether this peer has joined voice chat. */
  inVoice: boolean;
  /** Is this peer the current host? */
  isHost: boolean;
  /** When this peer joined. */
  joinedAt: number;
  /** Audio transport playhead — position in seconds + playing flag.
   *  null when the peer isn't in the audio editor or isn't playing. */
  audio: { pos: number; playing: boolean } | null;
}

/** Voice level above which a peer counts as "talking" — the threshold the
 *  People widget's speaking ring uses, and the one the client's roster key
 *  quantizes to so a level that merely wobbled doesn't re-render the board. */
export const VOICE_ACTIVE_LEVEL = 0.08;

export function makeAwarenessState(partial: Partial<AwarenessState>): AwarenessState {
  return {
    id: partial.id ?? '',
    name: partial.name ?? 'Guest',
    color: partial.color ?? '#7c6aff',
    tool: partial.tool ?? 'select',
    cursor: partial.cursor ?? null,
    cam: partial.cam ?? null,
    selection: partial.selection ?? [],
    voiceLevel: partial.voiceLevel ?? 0,
    inVoice: partial.inVoice ?? false,
    isHost: partial.isHost ?? false,
    joinedAt: partial.joinedAt ?? Date.now(),
    audio: partial.audio ?? null,
  };
}

/**
 * A key over the parts of an awareness snapshot that roster UI actually
 * renders: who is here, what they're called, and their coarse presence flags.
 *
 * Awareness fires on every cursor move — 20 Hz per peer, so a board with six
 * people emits well over a hundred changes a second. Feeding those straight
 * into React state re-renders the whole workspace tree at that rate, which is
 * the difference between a board that stays smooth as people join and one that
 * gets visibly slower with every extra collaborator. Anything that moves
 * continuously (cursor, camera pose, audio playhead, exact voice level) is
 * deliberately excluded: the components that draw those subscribe to the room
 * themselves and write transforms imperatively, so they never needed the
 * re-render. Compare this key and skip the setState when it hasn't changed.
 *
 * Sorted, so a snapshot whose peers merely came back in a different order
 * (Yjs keys awareness by a clientId that changes on every reconnect) doesn't
 * read as a change.
 */
export function rosterKey(states: AwarenessState[]): string {
  const parts = states.map(
    (s) =>
      `${s.id}|${s.name}|${s.color}|${s.isHost ? 1 : 0}|${s.inVoice ? 1 : 0}|` +
      `${s.voiceLevel > VOICE_ACTIVE_LEVEL ? 1 : 0}|${s.cam ? 1 : 0}|${s.audio ? 1 : 0}|` +
      `${s.joinedAt}`,
  );
  parts.sort();
  return parts.join(';');
}

/** Stable peer color palette — color is computed by hashing the peer id. */
export const PEER_COLORS = [
  '#7c6aff',
  '#22d3a5',
  '#fbbf24',
  '#f87171',
  '#60a5fa',
  '#f472b6',
  '#34d399',
  '#a78bfa',
  '#fb923c',
  '#2dd4bf',
] as const;

export function colorForPeerId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]!;
}

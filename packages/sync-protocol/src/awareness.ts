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
  /** Currently selected ids (2D shape/stroke ids OR 3D object ids). */
  selection: string[];
  /** Voice activity level 0..1 for talking indicator. */
  voiceLevel: number;
  /** Is this peer the current host? */
  isHost: boolean;
  /** When this peer joined. */
  joinedAt: number;
}

export function makeAwarenessState(partial: Partial<AwarenessState>): AwarenessState {
  return {
    id: partial.id ?? '',
    name: partial.name ?? 'Guest',
    color: partial.color ?? '#7c6aff',
    tool: partial.tool ?? 'select',
    cursor: partial.cursor ?? null,
    selection: partial.selection ?? [],
    voiceLevel: partial.voiceLevel ?? 0,
    isHost: partial.isHost ?? false,
    joinedAt: partial.joinedAt ?? Date.now(),
  };
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

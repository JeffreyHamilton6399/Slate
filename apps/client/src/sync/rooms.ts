/**
 * Lightweight REST client for the public room registry. The list is just for
 * the Boards panel discovery; joining always opens a Yjs doc by name and
 * trusts CRDT for the rest.
 */
import type { RoomInfo } from '@slate/sync-protocol';

export interface PublicRoom {
  name: string;
  visibility: 'public' | 'private';
  hostId: string;
  topic: string;
  mode: '2d' | '3d';
  members: number;
  createdAt: number;
}

type RoomsResponse = { rooms: PublicRoom[] };

export async function fetchRooms(): Promise<PublicRoom[]> {
  try {
    const r = await fetch('/api/rooms');
    if (!r.ok) return [];
    const body = (await r.json()) as RoomsResponse;
    return body.rooms ?? [];
  } catch {
    return [];
  }
}

/** Long-poll the rooms list — fine for v2 scale; can swap to SSE later. */
export function pollRooms(
  onUpdate: (rooms: PublicRoom[]) => void,
  intervalMs = 5000,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function tick() {
    if (cancelled) return;
    onUpdate(await fetchRooms());
    timer = setTimeout(tick, intervalMs);
  }
  void tick();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

// Re-export the server-side info type so callers can share.
export type { RoomInfo };

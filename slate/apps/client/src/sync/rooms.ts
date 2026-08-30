/**
 * Lightweight REST client for the public room registry. The list is just for
 * the Boards panel discovery; joining always opens a Yjs doc by name and
 * trusts CRDT for the rest.
 */
import type { DocMode, RoomInfo } from '@slate/sync-protocol';
import { apiUrl } from './serverUrl.js';

export interface PublicRoom {
  name: string;
  visibility: 'public' | 'private';
  hostId: string;
  topic: string;
  mode: DocMode;
  members: number;
  createdAt: number;
}

type RoomsResponse = { rooms: PublicRoom[] };

export async function fetchRooms(): Promise<PublicRoom[]> {
  try {
    const r = await fetch(apiUrl('/api/rooms'));
    if (!r.ok) return [];
    const body = (await r.json()) as RoomsResponse;
    return body.rooms ?? [];
  } catch {
    return [];
  }
}

/** Long-poll the rooms list — fine for v2 scale; can swap to SSE later.
 *
 *  Skips the request while the tab is hidden and catches up the moment it
 *  comes back. Nobody is reading the list behind a hidden tab, and the tabs
 *  people leave open outnumber the ones they're looking at: those requests are
 *  pure cost, spending the server's per-IP budget (which a whole classroom or
 *  office shares behind one NAT address) and the device's radio every five
 *  seconds for as long as the tab exists. */
export function pollRooms(
  onUpdate: (rooms: PublicRoom[]) => void,
  intervalMs = 5000,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hidden = (): boolean => typeof document !== 'undefined' && document.hidden;

  async function refresh() {
    const rooms = await fetchRooms();
    if (!cancelled) onUpdate(rooms);
  }
  async function tick() {
    if (cancelled) return;
    if (!hidden()) await refresh();
    if (cancelled) return;
    timer = setTimeout(tick, intervalMs);
  }
  const onVisibility = () => {
    if (!hidden()) void refresh();
  };

  void tick();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// Re-export the server-side info type so callers can share.
export type { RoomInfo };

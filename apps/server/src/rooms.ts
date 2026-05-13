/**
 * In-memory room registry. Tracks live boards, their visibility, host, and
 * member count for the boards-panel discovery list.
 *
 * Persists last-known board names to the LevelDB store so the list survives
 * restarts (members count obviously resets to zero).
 */

import { EventEmitter } from 'node:events';
import type { RoomInfo } from '@slate/sync-protocol';

export type { RoomInfo };

export class RoomRegistry extends EventEmitter {
  private rooms = new Map<string, RoomInfo>();

  list(): RoomInfo[] {
    return [...this.rooms.values()];
  }

  publicRooms(): RoomInfo[] {
    return this.list().filter((r) => r.visibility === 'public');
  }

  get(name: string): RoomInfo | undefined {
    return this.rooms.get(name);
  }

  upsert(info: RoomInfo): void {
    this.rooms.set(info.name, info);
    this.emit('change');
  }

  setMembers(name: string, members: number): void {
    const r = this.rooms.get(name);
    if (!r) return;
    if (r.members === members) return;
    r.members = members;
    this.emit('change');
  }

  remove(name: string): void {
    if (this.rooms.delete(name)) this.emit('change');
  }
}

/**
 * LevelDB-backed Yjs document persistence for Hocuspocus.
 * Stores one entry per room name with the merged Yjs update encoded.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@hocuspocus/extension-database';
import { Level } from 'level';
import { env } from './config.js';

mkdirSync(resolve(env.STORAGE_DIR), { recursive: true });
const db = new Level<string, Uint8Array>(resolve(env.STORAGE_DIR, 'yjs'), {
  valueEncoding: 'view',
});

export const persistence = new Database({
  fetch: async ({ documentName }: { documentName: string }) => {
    try {
      return await db.get(documentName);
    } catch {
      return null;
    }
  },
  store: async ({
    documentName,
    state,
  }: {
    documentName: string;
    state: Uint8Array;
  }) => {
    await db.put(documentName, state);
  },
});

export async function listPersistedRoomNames(): Promise<string[]> {
  const out: string[] = [];
  for await (const key of db.keys()) out.push(key);
  return out;
}

/**
 * Hocuspocus Yjs relay configuration.
 *
 * Auth: each WebSocket upgrade carries a `token` field in the connection
 *       payload (signed by /api/identity). We reject anonymous connections.
 *
 * Room access: room name is the documentName. Public rooms accept any peer;
 *       private rooms require the host's allow-list (synced via Yjs awareness
 *       in the future; for now they accept-then-let-host-kick).
 */

import { Hocuspocus } from '@hocuspocus/server';
import { Logger } from '@hocuspocus/extension-logger';
import type * as Y from 'yjs';
import {
  DOC_KEYS,
  MAX_BOARD_NAME_LEN,
  MAX_UPDATE_BYTES,
  RATE_LIMIT_UPDATES_PER_SEC,
  type BoardMeta,
} from '@slate/sync-protocol';
import { env, isProd } from './config.js';
import { verifyIdentity } from './identity.js';
import { persistence } from './persistence.js';
import { RoomRegistry } from './rooms.js';

const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(peerId: string): boolean {
  const now = Date.now();
  const slot = rateLimits.get(peerId);
  if (!slot || slot.resetAt < now) {
    rateLimits.set(peerId, { count: 1, resetAt: now + 1000 });
    return true;
  }
  slot.count++;
  return slot.count <= RATE_LIMIT_UPDATES_PER_SEC;
}

/** Observers we attach so we can clean them up on doc destroy. */
const metaObservers = new WeakMap<Y.Map<unknown>, () => void>();

function syncRoomFromDoc(rooms: RoomRegistry, documentName: string, doc: Y.Doc): void {
  const meta = doc.getMap<unknown>(DOC_KEYS.meta);

  const readMeta = (): Partial<BoardMeta> => ({
    createdBy: meta.get('createdBy') as string | undefined,
    createdAt: meta.get('createdAt') as number | undefined,
    name: (meta.get('name') as string | undefined) ?? documentName,
    topic: (meta.get('topic') as string | undefined) ?? '',
    visibility: meta.get('visibility') as BoardMeta['visibility'] | undefined,
    mode: meta.get('mode') as BoardMeta['mode'] | undefined,
    hostId: meta.get('hostId') as string | undefined,
  });

  const upsert = (): void => {
    const m = readMeta();
    if (!m.visibility || !m.mode) return;
    const existing = rooms.get(documentName);
    rooms.upsert({
      name: documentName,
      visibility: m.visibility,
      hostId: m.hostId ?? m.createdBy ?? '',
      topic: m.topic ?? '',
      mode: m.mode,
      createdAt: m.createdAt ?? Date.now(),
      members: existing?.members ?? 0,
    });
  };

  upsert();
  if (!metaObservers.has(meta)) {
    meta.observe(upsert);
    metaObservers.set(meta, upsert);
  }
}

export function createRelay(rooms: RoomRegistry): Hocuspocus {
  return new Hocuspocus({
    name: 'slate-relay',
    extensions: [
      persistence,
      ...(isProd ? [] : [new Logger({ onLoadDocument: false, onStoreDocument: false })]),
    ],
    async onAuthenticate(data: { token?: string; documentName: string }) {
      const { token, documentName } = data;
      if (!token) throw new Error('missing token');
      if (!documentName || documentName.length > MAX_BOARD_NAME_LEN) {
        throw new Error('invalid room name');
      }
      const claims = await verifyIdentity(token);
      return {
        peerId: claims.sub,
        name: claims.name,
      };
    },
    async afterLoadDocument(data: { documentName: string; document: Y.Doc }) {
      syncRoomFromDoc(rooms, data.documentName, data.document);
    },
    async onConnect(data: { documentName: string }) {
      const r = rooms.get(data.documentName);
      if (r) rooms.setMembers(r.name, (r.members ?? 0) + 1);
    },
    async onDisconnect(data: { documentName: string }) {
      const r = rooms.get(data.documentName);
      if (r) {
        const next = Math.max(0, (r.members ?? 1) - 1);
        rooms.setMembers(r.name, next);
        if (next === 0 && r.visibility === 'private') rooms.remove(r.name);
      }
    },
    async onStateless({ payload, connection }: { payload: string; connection: { context: { peerId?: string } } }) {
      const peerId = connection.context?.peerId ?? 'anon';
      if (!checkRateLimit(peerId)) return;
      void payload;
    },
    // Reject oversized incoming updates at the transport layer too.
    async beforeHandleMessage(data: {
      update?: Uint8Array;
      context: { peerId?: string };
    }) {
      const peerId = data.context?.peerId ?? 'anon';
      if (!checkRateLimit(peerId)) {
        throw new Error('rate limit');
      }
      if (data.update && data.update.byteLength > MAX_UPDATE_BYTES) {
        throw new Error('update too large');
      }
    },
  });
}

void env;

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
  type BoardMeta,
} from '@slate/sync-protocol';
import { env, isProd } from './config.js';
import { verifyIdentity } from './identity.js';
import { persistence } from './persistence.js';
import { checkRateLimit } from './rateLimit.js';
import { RoomRegistry } from './rooms.js';

/**
 * What we do about a peer that outruns its message budget: stop reading its
 * socket for a moment, then carry on.
 *
 * The obvious alternative — refusing the message — is worse in both
 * directions. Hocuspocus turns a rejected message into a closed connection,
 * and the client reads the close code it uses (Forbidden) as "your token was
 * refused": the socket stops dead and only comes back when the app re-dials by
 * hand. Handing it a code it doesn't special-case instead makes it reconnect
 * immediately, which is worse still — a peer that is genuinely sending too
 * fast reconnects, replays, trips again, and hammers the server with a full
 * re-sync several hundred times a second (measured: ~500 reconnects/s from a
 * single peer). And dropping the message silently is the worst of the three:
 * the client believes it sent the update and nothing ever asks for it again,
 * so that edit is simply lost for everyone else.
 *
 * Pausing the socket pushes back through TCP instead. The sender's own buffers
 * fill, its writes slow down, nothing is dropped, no connection is lost, and
 * the peer's edits all arrive — just spread over slightly more time. One pause
 * refills a quarter-second of budget.
 */
const THROTTLE_PAUSE_MS = 250;
/** Ceiling on a single pause. A peer that keeps flooding gets progressively
 *  longer pauses, but never long enough to look like a dead connection. */
const THROTTLE_MAX_PAUSE_MS = 1_000;
/** Going over budget again this soon after being resumed means the peer is
 *  still flooding rather than having had one legitimate burst, so the next
 *  pause doubles. A peer that blips once pays 250ms and nothing more. */
const THROTTLE_ESCALATE_WINDOW_MS = 1_000;

interface ThrottleState {
  paused: boolean;
  /** Length of the next pause. */
  pause: number;
  /** When the last pause ended. */
  resumedAt: number;
}

/** Per-socket throttle bookkeeping, so a burst schedules one pause rather than
 *  one per message. WeakMap: a closed socket must not be kept alive by this. */
const throttles = new WeakMap<object, ThrottleState>();

/** The raw `ws` socket behind a Hocuspocus connection, when it exposes the
 *  stream controls (it always does in this deployment — @fastify/websocket
 *  hands the relay real `ws` sockets — but the relay must not fall over if a
 *  future transport doesn't). */
interface PausableSocket {
  pause?: () => void;
  resume?: () => void;
}

function throttlePeer(connection: { webSocket?: PausableSocket } | undefined): void {
  const ws = connection?.webSocket;
  if (!ws || typeof ws.pause !== 'function' || typeof ws.resume !== 'function') return;
  let state = throttles.get(ws);
  if (!state) {
    state = { paused: false, pause: THROTTLE_PAUSE_MS, resumedAt: 0 };
    throttles.set(ws, state);
  }
  if (state.paused) return;
  const now = Date.now();
  state.pause =
    now - state.resumedAt < THROTTLE_ESCALATE_WINDOW_MS
      ? Math.min(state.pause * 2, THROTTLE_MAX_PAUSE_MS)
      : THROTTLE_PAUSE_MS;
  state.paused = true;
  ws.pause();
  const timer = setTimeout(() => {
    state.paused = false;
    state.resumedAt = Date.now();
    try {
      ws.resume?.();
    } catch {
      // Socket closed while paused — nothing to resume.
    }
  }, state.pause);
  timer.unref?.(); // never hold the process open for a throttle
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
    // Seed the member count from the LIVE connection count, not 0: on a brand
    // new board the creator's onConnect fires BEFORE the meta sync registers
    // the room (setMembers no-ops on an unknown room), so seeding 0 left the
    // creator invisible in the "live public boards" list (members > 0 filter)
    // until they left and rejoined.
    const liveConnections =
      (doc as unknown as { getConnectionsCount?: () => number }).getConnectionsCount?.() ?? 0;
    rooms.upsert({
      name: documentName,
      visibility: m.visibility,
      hostId: m.hostId ?? m.createdBy ?? '',
      topic: m.topic ?? '',
      mode: m.mode,
      createdAt: m.createdAt ?? Date.now(),
      members: Math.max(existing?.members ?? 0, liveConnections),
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
      let claims;
      try {
        claims = await verifyIdentity(token);
      } catch {
        // Rethrow as a plain Error. jose's failures (ERR_JWT_EXPIRED,
        // ERR_JWS_SIGNATURE_VERIFICATION_FAILED, ...) carry a *string* `code`,
        // and Hocuspocus passes error.code straight to websocket.close() —
        // a non-numeric close code throws there, and its fallback closes the
        // socket as Unauthorized. The client treats Unauthorized as fatal
        // (shouldConnect = false) and never reconnects, so an expired token or
        // a rotated signing secret would strand that tab until a page reload.
        // A codeless error closes with Forbidden, which the client retries —
        // and its token callback re-issues on the way back in.
        throw new Error('invalid token');
      }
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
    async onStateless({
      payload,
      connection,
      socketId,
    }: {
      payload: string;
      connection: { context: { peerId?: string }; webSocket?: PausableSocket };
      socketId?: string;
    }) {
      if (!checkRateLimit(budgetKey(connection.context, socketId))) throttlePeer(connection);
      void payload;
    },
    async beforeHandleMessage(data: {
      update?: Uint8Array;
      context: { peerId?: string };
      socketId?: string;
      connection?: { webSocket?: PausableSocket };
    }) {
      // Over budget: slow this peer down rather than refusing the message.
      if (!checkRateLimit(budgetKey(data.context, data.socketId))) throttlePeer(data.connection);
      // Oversized updates ARE refused — they're rejected by the transport's
      // maxPayload a step earlier anyway, and no amount of waiting makes a
      // 48 MB message acceptable.
      if (data.update && data.update.byteLength > MAX_UPDATE_BYTES) {
        throw new Error('update too large');
      }
    },
  });
}

/** Which budget an incoming message spends from. The peer id is the real
 *  subject — one bucket per person, shared across their reconnects — and the
 *  socket id is the fallback so a message that somehow arrives without a
 *  verified context spends its OWN budget rather than a single shared 'anon'
 *  bucket that every such connection would drain together. */
function budgetKey(context: { peerId?: string } | undefined, socketId?: string): string {
  return context?.peerId ?? (socketId ? `socket:${socketId}` : 'anon');
}

void env;

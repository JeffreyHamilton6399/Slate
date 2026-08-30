/**
 * SlateRoom — the integrated client-side connection to a single board.
 *
 *   - Y.Doc as source of truth
 *   - IndexeddbPersistence for offline + instant reload
 *   - HocuspocusProvider for live sync over WSS
 *   - Awareness for cursors/presence
 *   - UndoManager for local Ctrl/Cmd+Z
 *
 * Cleanup: call `dispose()` on unmount; all listeners + sockets close.
 */

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
  colorForPeerId,
  makeAwarenessState,
  sanitizeDisplayName,
  type AwarenessState,
} from '@slate/sync-protocol';
import { clearIdentity, ensureIdentity, type Identity } from './identity.js';
import { ensureServerProbe, useServerStatus } from './serverStatus.js';
import { wsUrl } from './serverUrl.js';
import { createSlateDoc, migrateLegacyContainers, type SlateDoc } from './doc.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Re-auth backoff bounds after the server rejects our token. */
const AUTH_RETRY_BASE_MS = 2_000;
const AUTH_RETRY_MAX_MS = 30_000;
/** Beat between closing the refused socket and dialling a fresh one. */
const AUTH_SOCKET_REBUILD_MS = 250;

export interface SlateRoomOptions {
  /** Room name (board name) — used both as Yjs doc name and WS topic. */
  room: string;
  /** Optional display name override (falls back to cached identity). */
  displayName?: string;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

export class SlateRoom {
  readonly room: string;
  readonly slate: SlateDoc;
  readonly identity: Identity;
  readonly idb: IndexeddbPersistence;
  readonly provider: HocuspocusProvider;
  readonly socket: HocuspocusProviderWebsocket;
  readonly undo: Y.UndoManager;

  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private awarenessListeners = new Set<(states: AwarenessState[]) => void>();
  private status: ConnectionStatus = 'connecting';
  /** Set while waiting for a late server appearance (local-only start). */
  unsubscribeServerStatus: (() => void) | null = null;
  /** Pending re-auth attempt after a rejected token, and its current backoff. */
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private authRetryDelay = AUTH_RETRY_BASE_MS;

  private constructor(opts: {
    room: string;
    identity: Identity;
    slate: SlateDoc;
    idb: IndexeddbPersistence;
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
    online: boolean;
  }) {
    this.status = opts.online ? 'connecting' : 'disconnected';
    this.room = opts.room;
    this.slate = opts.slate;
    this.identity = opts.identity;
    this.idb = opts.idb;
    this.provider = opts.provider;
    this.socket = opts.socket;

    const tracked = [
      this.slate.shapes(),
      this.slate.strokes(),
      this.slate.layers(),
      this.slate.scene3dObjects(),
      this.slate.scene3dMeshes(),
      this.slate.scene3dMaterials(),
      this.slate.notes(),
      this.slate.diagramNodes(),
      this.slate.diagramEdges(),
      this.slate.slides(),
      this.slate.slideElements(),
    ] as unknown as Y.AbstractType<unknown>[];
    this.undo = new Y.UndoManager(tracked, {
      captureTimeout: 350,
    });

    this.provider.on('status', this.onStatus);
    this.provider.on('disconnect', this.onDisconnect);
    this.provider.on('connect', this.onConnect);
    this.provider.on('synced', this.onSynced);
    this.provider.on('authenticationFailed', this.onAuthFailed);
    this.provider.awareness?.on('change', this.onAwareness);

    // Publish initial awareness immediately so other peers see us as joining.
    this.publishLocalAwareness({
      id: this.identity.peerId,
      name: this.identity.name,
      color: colorForPeerId(this.identity.peerId),
      tool: 'select',
      cursor: null,
      cam: null,
      selection: [],
      voiceLevel: 0,
      inVoice: false,
      isHost: false,
      joinedAt: Date.now(),
      audio: null,
    });
  }

  static async open(opts: SlateRoomOptions): Promise<SlateRoom> {
    // Only dial the sync server when the probe says one exists — otherwise
    // Hocuspocus retries forever and the UI reads "connecting" indefinitely.
    const availability = await ensureServerProbe();
    const identity = await ensureIdentity(opts.displayName);
    const slate = createSlateDoc();
    const idb = new IndexeddbPersistence(`slate:${opts.room}`, slate.doc);
    // Wait for IndexedDB hydration so the UI doesn't flash empty on reload.
    await idb.whenSynced;
    // Lift any data saved under the old nested container layout into the
    // top-level containers the accessors now read from.
    migrateLegacyContainers(slate.doc);

    // Last token the server actually issued us, kept as the fallback for the
    // reconnect callback below.
    let lastToken = identity.token;

    const wsUrl = computeWsUrl(opts.room);
    const socket = new HocuspocusProviderWebsocket({
      url: wsUrl,
      connect: availability === 'online',
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: opts.room,
      document: slate.doc,
      // Resolved on every (re)connect rather than captured once. A token is
      // only valid for JWT_TTL_SECONDS (24h) and is signed with a secret the
      // server may have rotated since — in production an unset JWT_SECRET is a
      // fresh random key each boot. With a fixed string here, Hocuspocus keeps
      // replaying the same dead token: the server closes with Forbidden, the
      // provider reconnects, and the loop never ends, so the board sits
      // disconnected until the tab is reloaded.
      token: async () => {
        const fresh = await ensureIdentity(identity.name);
        if (fresh.token) lastToken = fresh.token;
        // Never resolve to an empty string. ensureIdentity falls back to a
        // token-less offline identity whenever the issuing request fails —
        // which is exactly what happens while the server is restarting — and
        // Hocuspocus closes an empty auth message with Unauthorized, then sets
        // shouldConnect = false and gives up for good. Any non-empty token is
        // merely Forbidden, which keeps retrying until the server is back.
        // 'notoken' is the library's own placeholder for this case.
        return lastToken || 'notoken';
      },
      // Hocuspocus client sends token in connectionParams.
      forceSyncInterval: 30_000,
    });

    const roomInstance = new SlateRoom({
      room: opts.room,
      identity,
      slate,
      idb,
      provider,
      socket,
      online: availability === 'online',
    });
    if (availability !== 'online') {
      // The background re-probe may find the server later — connect then.
      roomInstance.unsubscribeServerStatus = useServerStatus.subscribe((s) => {
        if (s.availability === 'online') {
          roomInstance.unsubscribeServerStatus?.();
          roomInstance.unsubscribeServerStatus = null;
          socket.connect();
        }
      });
    }
    return roomInstance;
  }

  /** Plain-JS snapshot of all visible peer awareness states.
   *
   *  Deduped by peer id: a browser refresh or reconnect gives the same person a
   *  brand-new Yjs clientId while their previous awareness entry lingers until
   *  it times out, so a single user who reloaded a few times would otherwise be
   *  counted as many people ("30 people" on an empty board). We keep only the
   *  most recently-joined entry per peer id and drop the stale duplicates. */
  awarenessStates(): AwarenessState[] {
    if (!this.provider.awareness) return [];
    const byPeer = new Map<string, AwarenessState>();
    for (const [clientId, raw] of this.provider.awareness.getStates()) {
      const state = (raw as { slate?: AwarenessState })?.slate;
      if (!state) continue;
      const normalized: AwarenessState = { ...state, id: state.id || String(clientId) };
      const existing = byPeer.get(normalized.id);
      // Keep the freshest entry for this peer (largest joinedAt wins).
      if (!existing || (normalized.joinedAt ?? 0) >= (existing.joinedAt ?? 0)) {
        byPeer.set(normalized.id, normalized);
      }
    }
    return [...byPeer.values()];
  }

  /** Update our local awareness slot (partial merge). */
  setLocalAwareness(partial: Partial<AwarenessState>): void {
    if (!this.provider.awareness) return;
    const prev =
      (this.provider.awareness.getLocalState() as { slate?: AwarenessState } | null)?.slate ??
      makeAwarenessState({ id: this.identity.peerId, name: this.identity.name });
    const next = makeAwarenessState({ ...prev, ...partial, id: this.identity.peerId });
    this.provider.awareness.setLocalStateField('slate', next);
  }

  publishLocalAwareness(state: AwarenessState): void {
    if (!this.provider.awareness) return;
    this.provider.awareness.setLocalStateField('slate', state);
  }

  onStatusChange(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  onAwarenessChange(fn: (states: AwarenessState[]) => void): () => void {
    this.awarenessListeners.add(fn);
    fn(this.awarenessStates());
    return () => this.awarenessListeners.delete(fn);
  }

  renameMe(displayName: string): void {
    const name = sanitizeDisplayName(displayName);
    this.setLocalAwareness({ name });
  }

  dispose(): void {
    this.unsubscribeServerStatus?.();
    this.unsubscribeServerStatus = null;
    if (this.authRetryTimer !== null) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    this.provider.off('status', this.onStatus);
    this.provider.off('disconnect', this.onDisconnect);
    this.provider.off('connect', this.onConnect);
    this.provider.off('synced', this.onSynced);
    this.provider.off('authenticationFailed', this.onAuthFailed);
    this.provider.awareness?.off('change', this.onAwareness);
    this.statusListeners.clear();
    this.awarenessListeners.clear();
    this.undo.destroy();
    this.provider.destroy();
    this.socket.destroy();
    this.idb.destroy();
    this.slate.doc.destroy();
  }

  // ── private ───────────────────────────────────────────────────────────────
  private onStatus = (e: { status: string }): void => {
    const map: Record<string, ConnectionStatus> = {
      connecting: 'connecting',
      connected: 'connected',
      disconnected: 'disconnected',
    };
    const next = map[e.status] ?? 'error';
    this.status = next;
    for (const fn of this.statusListeners) fn(next);
  };
  private onConnect = (): void => {
    this.authRetryDelay = AUTH_RETRY_BASE_MS;
    this.status = 'connected';
    for (const fn of this.statusListeners) fn('connected');
  };
  private onDisconnect = (): void => {
    this.status = 'disconnected';
    for (const fn of this.statusListeners) fn('disconnected');
  };
  /** The token we sent was rejected — it expired, or the server is signing
   *  with a different secret than the one that issued it. Hocuspocus reacts by
   *  detaching the provider and going quiet, so nothing reconnects on its own:
   *  without this the board stays dead until the tab is reloaded.
   *
   *  Drop the cached identity (so the token callback issues a fresh one rather
   *  than replaying the dead token) and dial back in. `this.identity` is left
   *  alone for display — re-issuing mints a new peer id, and swapping it
   *  mid-session would make the user reappear to everyone else as a stranger.
   *
   *  Backs off 2s → 30s so a server that is rejecting every token gets a
   *  steady retry rather than a hot loop; a successful connect resets it. */
  private onAuthFailed = (): void => {
    clearIdentity();
    if (this.authRetryTimer !== null) return; // a retry is already queued
    const delay = this.authRetryDelay;
    this.authRetryDelay = Math.min(delay * 2, AUTH_RETRY_MAX_MS);
    this.authRetryTimer = setTimeout(() => {
      // Rebuild the socket rather than retrying on the refused one. After a
      // permission-denied the server leaves that connection open, and the idle
      // timer it armed on connect then closes it with Unauthorized — which the
      // provider treats as fatal (shouldConnect = false). A same-socket retry
      // races that timer and loses, ending the session for good.
      this.socket.disconnect();
      this.authRetryTimer = setTimeout(() => {
        this.authRetryTimer = null;
        this.socket.connect();
        void this.provider.connect();
      }, AUTH_SOCKET_REBUILD_MS);
    }, delay);
  };
  // First server sync can deliver a board still using the old nested container
  // layout; lift it into the top-level containers so the scene/audio show up.
  private onSynced = (): void => {
    migrateLegacyContainers(this.slate.doc);
  };
  private onAwareness = (_change: AwarenessChange): void => {
    const states = this.awarenessStates();
    for (const fn of this.awarenessListeners) fn(states);
  };
}

function computeWsUrl(room: string): string {
  return wsUrl(`/yjs/${encodeURIComponent(room)}`);
}

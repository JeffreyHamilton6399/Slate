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
import { ensureIdentity, type Identity } from './identity.js';
import { createSlateDoc, type SlateDoc } from './doc.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

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

  private constructor(opts: {
    room: string;
    identity: Identity;
    slate: SlateDoc;
    idb: IndexeddbPersistence;
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
  }) {
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
    ] as unknown as Y.AbstractType<unknown>[];
    this.undo = new Y.UndoManager(tracked, {
      captureTimeout: 350,
    });

    this.provider.on('status', this.onStatus);
    this.provider.on('disconnect', this.onDisconnect);
    this.provider.on('connect', this.onConnect);
    this.provider.awareness?.on('change', this.onAwareness);

    // Publish initial awareness immediately so other peers see us as joining.
    this.publishLocalAwareness({
      id: this.identity.peerId,
      name: this.identity.name,
      color: colorForPeerId(this.identity.peerId),
      tool: 'select',
      cursor: null,
      selection: [],
      voiceLevel: 0,
      isHost: false,
      joinedAt: Date.now(),
    });
  }

  static async open(opts: SlateRoomOptions): Promise<SlateRoom> {
    const identity = await ensureIdentity(opts.displayName);
    const slate = createSlateDoc();
    const idb = new IndexeddbPersistence(`slate:${opts.room}`, slate.doc);
    // Wait for IndexedDB hydration so the UI doesn't flash empty on reload.
    await idb.whenSynced;

    const wsUrl = computeWsUrl(opts.room);
    const socket = new HocuspocusProviderWebsocket({ url: wsUrl });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: opts.room,
      document: slate.doc,
      token: identity.token,
      // Hocuspocus client sends token in connectionParams.
      forceSyncInterval: 30_000,
    });

    return new SlateRoom({ room: opts.room, identity, slate, idb, provider, socket });
  }

  /** Plain-JS snapshot of all visible peer awareness states. */
  awarenessStates(): AwarenessState[] {
    if (!this.provider.awareness) return [];
    const out: AwarenessState[] = [];
    for (const [clientId, raw] of this.provider.awareness.getStates()) {
      const state = (raw as { slate?: AwarenessState })?.slate;
      if (!state) continue;
      // Skip ourselves; UI will overlay local cursor differently.
      out.push({ ...state, id: state.id || String(clientId) });
    }
    return out;
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
    this.provider.off('status', this.onStatus);
    this.provider.off('disconnect', this.onDisconnect);
    this.provider.off('connect', this.onConnect);
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
    this.status = 'connected';
    for (const fn of this.statusListeners) fn('connected');
  };
  private onDisconnect = (): void => {
    this.status = 'disconnected';
    for (const fn of this.statusListeners) fn('disconnected');
  };
  private onAwareness = (_change: AwarenessChange): void => {
    const states = this.awarenessStates();
    for (const fn of this.awarenessListeners) fn(states);
  };
}

function computeWsUrl(room: string): string {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}/yjs/${encodeURIComponent(room)}`;
}

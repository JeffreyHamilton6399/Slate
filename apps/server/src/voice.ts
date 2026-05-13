/**
 * Voice signaling — a thin WebSocket broadcast keyed by room name. Each peer
 * announces itself; the server simply relays SDP / ICE messages between peers
 * in the same room. Actual audio is WebRTC P2P (TURN-relayed if needed).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyIdentity } from './identity.js';

const messageSchema = z.object({
  type: z.enum(['hello', 'offer', 'answer', 'ice', 'bye']),
  room: z.string().min(1).max(80),
  to: z.string().optional(),
  payload: z.unknown().optional(),
});

interface VoicePeer {
  id: string;
  name: string;
  room: string;
  send: (data: unknown) => void;
}

const peersByRoom = new Map<string, Map<string, VoicePeer>>();

function joinRoom(peer: VoicePeer) {
  let bucket = peersByRoom.get(peer.room);
  if (!bucket) {
    bucket = new Map();
    peersByRoom.set(peer.room, bucket);
  }
  bucket.set(peer.id, peer);
  // Tell existing peers about the new one and vice-versa.
  for (const other of bucket.values()) {
    if (other.id === peer.id) continue;
    other.send({ type: 'hello', from: peer.id, name: peer.name });
    peer.send({ type: 'hello', from: other.id, name: other.name });
  }
}

function leaveRoom(peer: VoicePeer) {
  const bucket = peersByRoom.get(peer.room);
  if (!bucket) return;
  bucket.delete(peer.id);
  if (bucket.size === 0) peersByRoom.delete(peer.room);
  for (const other of bucket.values()) {
    other.send({ type: 'bye', from: peer.id });
  }
}

function relay(from: VoicePeer, to: string, msg: unknown) {
  const bucket = peersByRoom.get(from.room);
  if (!bucket) return;
  const target = bucket.get(to);
  if (!target) return;
  target.send({ ...(msg as object), from: from.id });
}

export function registerVoiceRoutes(app: FastifyInstance): void {
  app.get('/voice', { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string })?.token;
    const room = (req.query as { room?: string })?.room;
    if (!token || !room) {
      socket.close(1008, 'missing token/room');
      return;
    }
    let claims;
    try {
      claims = await verifyIdentity(token);
    } catch {
      socket.close(1008, 'bad token');
      return;
    }
    const peer: VoicePeer = {
      id: claims.sub,
      name: claims.name,
      room,
      send: (data) => {
        try {
          socket.send(JSON.stringify(data));
        } catch {
          /* socket closed */
        }
      },
    };
    joinRoom(peer);

    socket.on('message', (raw: Buffer | string) => {
      let parsed;
      try {
        parsed = messageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (parsed.type === 'hello' || parsed.type === 'bye') return;
      if (!parsed.to) return;
      relay(peer, parsed.to, parsed);
    });
    socket.on('close', () => leaveRoom(peer));
  });
}

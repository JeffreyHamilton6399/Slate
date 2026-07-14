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
  sendBinary: (data: Buffer) => void;
}

/** Audio frames are µ-law bytes; cap well above the ~1KB frames clients send. */
const MAX_AUDIO_FRAME_BYTES = 8192;

/** Frame sent to listeners: [1 byte id length][peerId utf8][µ-law payload]. */
function packAudioFrame(peerId: string, payload: Buffer): Buffer {
  const id = Buffer.from(peerId, 'utf8');
  return Buffer.concat([Buffer.from([id.length]), id, payload]);
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
      sendBinary: (data) => {
        try {
          socket.send(data, { binary: true });
        } catch {
          /* socket closed */
        }
      },
    };
    joinRoom(peer);

    socket.on('message', (raw: Buffer | string, isBinary: boolean) => {
      // Binary frames are relayed audio: broadcast to everyone else in the
      // room with the sender's id prefixed. No TURN/NAT dance — audio rides
      // the same WSS the client already has open.
      if (isBinary) {
        const buf = raw as Buffer;
        if (buf.length === 0 || buf.length > MAX_AUDIO_FRAME_BYTES) return;
        const bucket = peersByRoom.get(peer.room);
        if (!bucket) return;
        const frame = packAudioFrame(peer.id, buf);
        for (const other of bucket.values()) {
          if (other.id !== peer.id) other.sendBinary(frame);
        }
        return;
      }
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

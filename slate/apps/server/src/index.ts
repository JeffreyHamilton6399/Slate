/**
 * Slate server entrypoint.
 *
 * Single Node process exposing on one port:
 *   - GET  /             — built React client (in prod)
 *   - GET  /health       — liveness
 *   - GET  /api/identity — issue anonymous JWT
 *   - GET  /api/rooms    — public room registry
 *   - GET  /api/turn     — TURN ICE config (if configured)
 *   - WS   /yjs/:room    — Hocuspocus Yjs relay
 *   - WS   /voice        — voice signaling
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { z } from 'zod';
import { env, isProd } from './config.js';
import { issueIdentity } from './identity.js';
import { createRelay } from './relay.js';
import { RoomRegistry } from './rooms.js';
import { registerVoiceRoutes } from './voice.js';

const app = Fastify({
  logger: isProd ? { level: 'info' } : { level: 'debug' },
  trustProxy: true,
  bodyLimit: 1_000_000,
});

await app.register(helmet, {
  contentSecurityPolicy: false, // CSP applied via meta in index.html; WSS upgrade breaks under strict directives.
  crossOriginEmbedderPolicy: false,
});
await app.register(compress, { threshold: 1024 });
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });

// "*" allows any origin (identity is anonymous JWTs, boards are open by
// design); a comma-separated list restricts to specific client origins.
// Trailing slashes are stripped — browsers never send them in Origin.
const corsOrigins =
  env.CORS_ORIGINS.trim() === '*'
    ? true
    : env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',')
          .map((s) => s.trim().replace(/\/+$/, ''))
          .filter(Boolean)
      : false;
await app.register(cors, { origin: corsOrigins });

await app.register(websocket, {
  options: {
    maxPayload: 1_500_000,
  },
});

// ── In-memory state ─────────────────────────────────────────────────────────
const rooms = new RoomRegistry();
const relay = createRelay(rooms);

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', uptime: Math.floor(process.uptime()) }));

const identityBody = z.object({
  displayName: z.string().min(1).max(80),
});
app.post('/api/identity', async (req, reply) => {
  const parsed = identityBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'invalid body' };
  }
  return issueIdentity(parsed.data.displayName);
});

app.get('/api/rooms', async () => ({ rooms: rooms.publicRooms() }));

const STUN_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/** Cached ICE servers from TURN_CREDENTIALS_URL (Metered et al rotate creds). */
let turnCache: { servers: unknown[]; fetchedAt: number } | null = null;
const TURN_CACHE_MS = 60 * 60 * 1000;

async function fetchTurnServers(url: string): Promise<unknown[]> {
  if (turnCache && Date.now() - turnCache.fetchedAt < TURN_CACHE_MS) return turnCache.servers;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`turn credentials fetch failed: ${r.status}`);
  const body = (await r.json()) as unknown;
  // Metered returns a bare array; other providers wrap it in { iceServers }.
  const servers = Array.isArray(body)
    ? body
    : ((body as { iceServers?: unknown[] }).iceServers ?? []);
  turnCache = { servers, fetchedAt: Date.now() };
  return servers;
}

app.get('/api/turn', async () => {
  if (env.TURN_CREDENTIALS_URL) {
    try {
      const servers = await fetchTurnServers(env.TURN_CREDENTIALS_URL);
      return { iceServers: [...STUN_SERVERS, ...servers] };
    } catch (err) {
      app.log.warn({ err }, 'turn credentials fetch failed; STUN only');
    }
  }
  if (env.TURN_URL) {
    return {
      iceServers: [
        ...STUN_SERVERS,
        {
          urls: env.TURN_URL,
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        },
      ],
    };
  }
  // STUN-only: fine for most home networks; strict NATs (often mobile data)
  // need a TURN relay — set TURN_CREDENTIALS_URL (see README, free tier).
  return { iceServers: STUN_SERVERS };
});

// Yjs Hocuspocus relay over /yjs/:room
app.register(async (instance) => {
  instance.get('/yjs/:room', { websocket: true }, async (socket, req) => {
    const room = (req.params as { room?: string })?.room;
    if (!room) {
      socket.close(1008, 'missing room');
      return;
    }
    const docName = decodeURIComponent(room);
    // Hocuspocus uses raw WebSocket pairs.
    relay.handleConnection(
      socket as unknown as WebSocket,
      req.raw,
      { documentName: docName },
    );
  });
});

registerVoiceRoutes(app);

// Static client (prod) — Vite outputs to apps/client/dist
const here = fileURLToPath(new URL('.', import.meta.url));
const clientDist = resolve(here, env.CLIENT_DIST);
if (existsSync(clientDist)) {
  await app.register(staticFiles, {
    root: clientDist,
    prefix: '/',
    cacheControl: true,
    maxAge: '1h',
    setHeaders(res, path) {
      if (path.endsWith('index.html') || path.endsWith('manifest.webmanifest')) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  });
  // SPA fallback.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET') {
      reply.code(404);
      return { error: 'not found' };
    }
    reply.type('text/html');
    return reply.sendFile('index.html');
  });
} else {
  app.log.info({ clientDist }, 'client dist not present; static serving disabled');
}

// ── Start ───────────────────────────────────────────────────────────────────
await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ port: env.PORT }, 'Slate server up');

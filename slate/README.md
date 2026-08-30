# Slate v2

Real-time collaborative 2D whiteboard and Blender-style 3D editor. PWA, no accounts. Yjs CRDT sync over WebSocket with WebRTC voice.

## Quickstart

```bash
pnpm install
pnpm dev:all
```

- Client: <http://localhost:5173>
- Server: <http://localhost:8080>

The Vite dev server proxies `/api`, `/yjs`, `/voice`, `/health` to the Node server, so you can open one URL.

## Monorepo layout

```
apps/
  client/   Vite + React + TS PWA
  server/   Fastify + Hocuspocus (Yjs relay) + voice signaling
packages/
  sync-protocol/  shared Yjs schema + zod validators
  mesh/           pure-TS mesh ops (extrude, bevel, loop-cut, ...)
  fbx-export/     tiny FBX 7.4 ASCII writer
  ui-tokens/      design tokens + Tailwind preset
```

The `Slate/Reference]/` folder contains the v1 reference snapshot — read-only design intent, never imported.

## Scripts

- `pnpm dev` — client only
- `pnpm dev:server` — server only
- `pnpm dev:all` — both
- `pnpm build` — production build
- `pnpm typecheck` / `pnpm lint` / `pnpm test`
- `pnpm test:e2e` — Playwright multi-peer
- `docker build . && docker run -p 8080:8080 slate` — single-image prod
  (pass `-e JWT_SECRET=...` for sessions that survive a restart; see below)

## Deployment

**Render (full stack, free):** dashboard → New → Blueprint → this repo. `render.yaml` deploys the single Docker image (server + built client) on the free plan and auto-deploys on push. Free-tier caveats: sleeps after ~15 min idle (~30-60s wake), no persistent disk (boards re-seed from browsers' IndexedDB on reconnect).

**Vercel (client only):** import the repo — `vercel.json` builds the client and serves `apps/client/dist`. Without a backend the app runs local-only (boards persist in IndexedDB; no live sync/voice). To enable sync, set the Vercel env var `VITE_SERVER_URL=https://your-server.example.com` to a hosted server (build-time; redeploy after changing it) and `CORS_ORIGINS=https://your-app.vercel.app` on that server.

**Fly.io (full stack):** set a signing secret once —
`flyctl secrets set JWT_SECRET="$(openssl rand -base64 32)"` — then `flyctl deploy`. See `fly.toml`. Persistent volume mounted at `/data` for Yjs LevelDB. The single Docker image serves both the API/WebSocket server and the built client.

### AI chat costs

`/api/ai-chat` is unauthenticated and spends the operator's Z.AI credits, so
the server caps it at 20 requests/min per IP (the rest of the API gets 200).
The Vercel serverless twin holds no shared state and cannot enforce that — if
you deploy the client to Vercel with `ZAI_*` set, put Vercel's own rate
limiting in front of it. Leaving `ZAI_*` unset disables the route entirely
(503), which is the default.

### Signing secret (`JWT_SECRET`)

Clients authenticate to the sync server with a short-lived anonymous JWT from
`/api/identity`, and that token is the only thing gating access to the Yjs
relay — anyone holding the signing key can mint one for any peer id and read or
write every board on the server.

- **Development** uses a fixed built-in secret so things just work.
- **Production** never falls back to it. Setting `JWT_SECRET` to the dev value
  is refused at boot, and leaving it unset generates a strong random key per
  boot — safe, but ephemeral: tokens do not survive a restart, and two
  instances would not agree. Clients notice and re-issue on their own, so this
  is fine for a single casual instance.
- **Set it explicitly** for stable sessions or more than one instance:
  `openssl rand -base64 32`. Render's blueprint already generates one; Fly and
  a bare `docker run` do not.

### Voice across networks (TURN)

Voice is WebRTC P2P. STUN alone connects most home networks, but strict NATs (typically mobile data) need a TURN relay or callers hear silence. Free option: create an app at [metered.ca](https://www.metered.ca/) (Open Relay free tier), then set on the server:

```
TURN_CREDENTIALS_URL=https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=<key>
```

The server fetches and caches the rotating credentials and hands them to clients via `/api/turn`. Alternatively set a static `TURN_URL` + `TURN_USERNAME` + `TURN_CREDENTIAL`.

## Architecture

See [`Slate v2 plan`](.cursor/plans/) for the full design.

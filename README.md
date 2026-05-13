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

## Deployment

Fly.io: `flyctl deploy`. See `fly.toml`. Persistent volume mounted at `/data` for Yjs LevelDB.

## Architecture

See [`Slate v2 plan`](.cursor/plans/) for the full design.

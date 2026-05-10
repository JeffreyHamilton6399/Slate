# Slate

Slate is a self-hosted collaborative whiteboard. Open a URL, share the room link (same URL hash), and everyone in that room edits the same canvas in real time. No accounts and no installs — just a browser.

## Run locally

```bash
npm install
npm start
```

Then open one of the URLs printed in the terminal (for example `http://localhost:8080`). The room is in the hash (for example `http://localhost:8080/#my-room`). Use **Share** to copy the full link.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP port |
| `KEEP_ALIVE_TIMEOUT` | `65000` | Node `server.keepAliveTimeout` (ms) |

## Stack

- **Express** + Node HTTP server (same shape as Chirp: compression, keep-alive, `/health`, graceful shutdown, `/peerjs` PeerJS signaling)
- **Single-file** `index.html` (no bundler): **tldraw** from CDN as ES modules (`type="module"`) and **PeerJS** for peer-to-peer sync over data channels
- **No persistence** — document state exists only in connected peers’ memory

## Docker

```bash
docker build -t slate .
docker run -p 8080:8080 slate
```

## PeerJS brokers

Optional query / `localStorage` keys (same pattern as Chirp): `peerHost`, `peerPort`, `peerPath`, `peerSecure` and `slate_peer_*` variants for defaults.

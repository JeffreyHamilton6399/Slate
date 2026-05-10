# Slate

Slate is a self-hosted collaborative whiteboard. Open a URL, share the room link (same URL hash), and everyone in that room edits the same canvas in real time. No accounts and no installs — just a browser.

## Run locally

```bash
npm install
npm start
```

Then open one of the URLs printed in the terminal (for example `http://localhost:8080`). The room is in the hash (for example `http://localhost:8080/#my-room`). Use **Share** to copy the full link.

**Rooms need a signaling server.** Opening `index.html` as a `file://` URL or deploying **only** static files (for example the default GitHub Pages workflow that uploads the repo as static assets) does **not** run Node, so there is **no `/peerjs` endpoint** and PeerJS cannot pair peers. You must either:

1. Run **`npm start`** (or Docker) so Express + PeerJS run on a real `http(s)://` origin, or  
2. Host the HTML somewhere static but point clients at a **separate** Node process that runs this same `server.js` (see below).

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP port |
| `KEEP_ALIVE_TIMEOUT` | `65000` | Node `server.keepAliveTimeout` (ms) |
| `TRUST_PROXY` | _(unset)_ | Set to `1` when behind a reverse proxy (Fly, Railway, nginx) so PeerJS sees correct HTTPS |

## Stack

- **Express** + Node HTTP server (same shape as Chirp: compression, keep-alive, `/health`, graceful shutdown, `/peerjs` PeerJS signaling)
- **Single-file** `index.html` (no bundler): **tldraw** from CDN as ES modules (`type="module"`) and **PeerJS** for peer-to-peer sync over data channels
- **No persistence** — document state exists only in connected peers’ memory

## Docker

```bash
docker build -t slate .
docker run -p 8080:8080 slate
```

## PeerJS brokers (same pattern as Chirp)

Optional **query string**: `peerHost`, `peerPort`, `peerPath`, `peerSecure`.

Optional **`localStorage`** keys: `slate_peer_host`, `slate_peer_port`, `slate_peer_path`, `slate_peer_secure`.

Optional **HTML meta** (for static deploys): set `slate-public-peer-host` to the **hostname only** of a machine running `server.js` (no `https://`). Example:

```html
<meta name="slate-public-peer-host" content="slate-signal.fly.dev">
```

That host must serve PeerJS at `https://THAT_HOST/peerjs` (same `path` and `ExpressPeerServer` mount as this repo’s `server.js`).

Broker order matches Chirp: PeerJS cloud brokers first, then the **current page origin** `/peerjs` (works when the app and Node share one host), then cloud again if you used a custom `peerHost`.

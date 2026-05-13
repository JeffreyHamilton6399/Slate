# Slate

**Slate** is a real-time collaborative whiteboard built on peer-to-peer WebRTC data channels (PeerJS). It works from a single `index.html` with no build step and no external frameworks — inspired by the same architecture as Chirp.

---

## Quickstart

```bash
npm install
npm start
```

Open **http://localhost:8080** in your browser (or the LAN IP shown in the terminal to join from another device).

---

## How it works

```
Each browser tab ──► slate-<uuid> peer
                       │
                       ├── connects to slate-lobby-0001 (lobby host, auto-elected)
                       │     • discovers public boards and member counts
                       │
                       └── full-mesh data channels with every peer in the same board
                             • doc-snap   – snapshot sent to new joiners
                             • doc-diff   – incremental strokes / shape changes
                             • presence   – cursor positions at ~10 Hz
                             • mod-kick   – host removes a peer
```

- **One Peer per user.** The same PeerJS peer handles lobby registration, board membership, and drawing sync simultaneously.
- **Lobby host election.** Any peer may claim the fixed well-known ID `slate-lobby-0001`. If that ID is already taken, the peer falls back to being a lobby client and syncs the board registry from the host every 10 s.
- **Public boards** are visible to everyone in the lobby list with live member counts.
- **Private boards** require a knock-to-join request. The board host sees an Allow / Deny modal; approved guests receive a `join-approved` message and are connected to the mesh.
- **No server-side state.** The Express server only runs the PeerJS WebRTC signaling broker (ICE negotiation) and serves the static file. All collaborative state is peer-to-peer.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port to listen on |
| `KEEP_ALIVE_TIMEOUT` | `65000` | Keep-alive timeout in ms (should exceed proxy idle timeout) |
| `TRUST_PROXY` | _(unset)_ | Set to `1` to trust `X-Forwarded-For` headers behind a reverse proxy |

---

## Deployment

The app can be deployed to any platform that runs Node.js (Fly.io, Railway, Render, etc.). Make sure the PeerJS signaling path `/peerjs` is accessible from clients. The `/health` endpoint can be used for health checks.

For production behind a TLS-terminating proxy (e.g. nginx, Caddy), set `TRUST_PROXY=1` and ensure WebSocket upgrades are forwarded to `/peerjs`.

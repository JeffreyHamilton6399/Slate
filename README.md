# Slate

Real-time collaborative 2D whiteboard and Blender-style 3D editor. Runs as a
PWA, needs no accounts, and syncs through Yjs CRDTs over a WebSocket with
WebRTC voice alongside.

**The app lives in [`slate/`](slate/) — start with [its README](slate/README.md).**

```bash
cd slate
pnpm install
pnpm dev:all
```

## Why the extra directory

`slate/` is a pnpm workspace and was originally the repository itself. It got
nested one level down so the deploy configuration for both hosts could sit at
the repo root, where Render's blueprint sync and Vercel both look for it:

- `render.yaml` deploys the full stack (server plus built client) as one Docker
  image, with `rootDir: slate`.
- `vercel.json` builds the client only and serves `slate/apps/client/dist`.
  Without a backend the app still works locally — boards persist to IndexedDB —
  but there is no live sync or voice until `VITE_SERVER_URL` points at a
  running server.

Everything else — sources, tests, Dockerfile, workspace packages — is under
`slate/`.

## License

MIT — see [LICENSE](LICENSE).

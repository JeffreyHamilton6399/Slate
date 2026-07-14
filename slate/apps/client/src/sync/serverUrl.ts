/**
 * Resolves the backend origin for API + WebSocket calls.
 *
 * Default: same origin — the Fastify server serves the built client in the
 * Docker/Fly deployment, so relative paths work.
 *
 * Static hosting (e.g. Vercel): set VITE_SERVER_URL to the https origin of a
 * hosted Slate server (e.g. https://slate.fly.dev) at build time. Without it,
 * sync/voice endpoints are unreachable and the app runs local-only.
 */

interface SlateImportMetaEnv {
  VITE_SERVER_URL?: string;
}

export function serverOrigin(): string {
  const env = import.meta.env as SlateImportMetaEnv;
  const configured = env.VITE_SERVER_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return window.location.origin;
}

/** Absolute URL for an API path like `/api/identity`. */
export function apiUrl(path: string): string {
  return `${serverOrigin()}${path}`;
}

/** Absolute ws(s):// URL for a WebSocket path like `/yjs/room`. */
export function wsUrl(path: string): string {
  const u = new URL(path, serverOrigin());
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

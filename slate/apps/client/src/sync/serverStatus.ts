/**
 * Shared server availability probe.
 *
 * One probe per page load decides what kind of backend we have:
 *   - 'online'  — /health answered; live sync can connect
 *   - 'waking'  — requests hang/5xx; likely a free-tier cold start (transient)
 *   - 'none'    — static hosting (SPA rewrite answers /health with HTML),
 *                 CORS misconfiguration, or the server never came up.
 *                 The app runs local-only and says so, instead of showing
 *                 "connecting" forever.
 *
 * Cold starts fail SLOW (the host holds the request while booting); CORS/DNS
 * failures fail FAST. Repeated fast failures short-circuit to 'none' so a
 * misconfigured origin doesn't stall the app for two minutes.
 */

import { create } from 'zustand';
import { apiUrl } from './serverUrl';

export type ServerAvailability = 'probing' | 'waking' | 'online' | 'none';

export const useServerStatus = create<{ availability: ServerAvailability }>(() => ({
  availability: 'probing',
}));

function setAvailability(availability: ServerAvailability): void {
  useServerStatus.setState({ availability });
}

const GIVE_UP_MS = 120_000;
const RETRY_MS = 3000;
const FAST_FAIL_MS = 2000;
const FAST_FAIL_LIMIT = 3;

async function probeOnce(
  timeoutMs: number,
): Promise<'online' | 'no-server' | 'unreachable'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(apiUrl('/health'), { signal: ctrl.signal, cache: 'no-store' });
    const type = r.headers.get('content-type') ?? '';
    if (r.ok && type.includes('application/json')) {
      const body = (await r.json()) as { status?: string };
      if (body.status === 'ok') return 'online';
    }
    // HTML back from /health = SPA rewrite = static hosting without a server.
    if (type.includes('text/html')) return 'no-server';
    return r.status >= 500 ? 'unreachable' : 'no-server';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

let probePromise: Promise<ServerAvailability> | null = null;

/** Kick off (or join) the availability probe; resolves when settled. */
export function ensureServerProbe(): Promise<ServerAvailability> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    const started = Date.now();
    let fastFails = 0;
    for (;;) {
      const attemptStart = Date.now();
      const result = await probeOnce(45_000);
      if (result === 'online') {
        setAvailability('online');
        return 'online' as const;
      }
      if (result === 'no-server') {
        setAvailability('none');
        return 'none' as const;
      }
      if (Date.now() - attemptStart < FAST_FAIL_MS) {
        fastFails++;
        if (fastFails >= FAST_FAIL_LIMIT) {
          setAvailability('none');
          return 'none' as const;
        }
      } else {
        fastFails = 0;
      }
      if (Date.now() - started > GIVE_UP_MS) {
        setAvailability('none');
        return 'none' as const;
      }
      setAvailability('waking');
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  })();
  void probePromise.then((result) => {
    // 'none' can be transient (flaky network at board-open used to leave the
    // client local-only for the whole session). Keep re-probing quietly and
    // flip to online when the server answers; SlateRoom connects on that.
    if (result === 'none') startBackgroundReprobe();
  });
  return probePromise;
}

let reprobeTimer: ReturnType<typeof setInterval> | null = null;

function startBackgroundReprobe(): void {
  if (reprobeTimer) return;
  reprobeTimer = setInterval(() => {
    void probeOnce(10_000).then((r) => {
      if (r === 'online') {
        setAvailability('online');
        if (reprobeTimer) clearInterval(reprobeTimer);
        reprobeTimer = null;
      }
    });
  }, 25_000);
}

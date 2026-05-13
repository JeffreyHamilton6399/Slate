/**
 * Anonymous identity client. Issues + caches a JWT from the server, scoped
 * to this browser tab (sessionStorage). Re-issued whenever the displayName
 * changes or the token nears expiry.
 */

import { sanitizeDisplayName } from '@slate/sync-protocol';

const KEY = 'slate.identity';
const NAME_KEY = 'slate.identity.name';

export interface Identity {
  token: string;
  peerId: string;
  name: string;
  /** Unix seconds; we re-issue 5 minutes before this. */
  exp: number;
}

interface IssueResponse {
  token: string;
  peerId: string;
  name: string;
}

function decodeExp(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

function load(): Identity | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Identity;
    if (!v.token || !v.peerId) return null;
    return v;
  } catch {
    return null;
  }
}

function save(id: Identity): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    /* ignore */
  }
}

export function getCachedName(): string {
  return localStorage.getItem(NAME_KEY) ?? '';
}

export function setCachedName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, sanitizeDisplayName(name));
  } catch {
    /* ignore */
  }
}

export async function ensureIdentity(displayName?: string): Promise<Identity> {
  const cached = load();
  const now = Math.floor(Date.now() / 1000);
  const requestedName = displayName ? sanitizeDisplayName(displayName) : undefined;
  if (
    cached &&
    cached.exp - now > 300 &&
    (!requestedName || requestedName === cached.name)
  ) {
    return cached;
  }
  const name = requestedName ?? cached?.name ?? getCachedName() ?? 'Guest';
  const r = await fetch('/api/identity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  if (!r.ok) throw new Error(`identity issue failed: ${r.status}`);
  const body = (await r.json()) as IssueResponse;
  const id: Identity = {
    token: body.token,
    peerId: body.peerId,
    name: body.name,
    exp: decodeExp(body.token),
  };
  save(id);
  setCachedName(id.name);
  return id;
}

export function clearIdentity(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

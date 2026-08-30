/**
 * Regression guard for the relay's authentication hook.
 *
 * Hocuspocus closes a refused connection with `error.code ?? Forbidden.code`.
 * jose's verification failures (ERR_JWT_EXPIRED,
 * ERR_JWS_SIGNATURE_VERIFICATION_FAILED, ...) carry a *string* `code`, and a
 * non-numeric close code makes `websocket.close()` throw — Hocuspocus then
 * falls back to closing with Unauthorized, which the client treats as fatal
 * (`shouldConnect = false`) and never retries. An expired token or a rotated
 * signing secret would strand that tab until a page reload.
 *
 * So the hook must reject with a plain, code-less Error.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Set before importing: config reads env at module load, and the relay's
// persistence layer opens a LevelDB under STORAGE_DIR as a side effect.
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'slate-relay-auth-'));

const { createRelay } = await import('./relay.js');
const { RoomRegistry } = await import('./rooms.js');
const { issueIdentity } = await import('./identity.js');

type AuthHook = (data: { token?: string; documentName: string }) => Promise<{
  peerId: string;
  name: string;
}>;

const onAuthenticate = createRelay(new RoomRegistry()).configuration
  .onAuthenticate as unknown as AuthHook;

/** What Hocuspocus does with a rejected hook's error. A close code must be a
 *  number, so anything else means the connection dies as Unauthorized. */
function closeCodeFor(err: unknown): unknown {
  return (err as { code?: unknown }).code ?? 4003; // Forbidden.code
}

describe('relay onAuthenticate', () => {
  it('accepts a freshly issued token', async () => {
    const id = await issueIdentity('Alice');
    const ctx = await onAuthenticate({ token: id.token, documentName: 'board' });
    expect(ctx.peerId).toBe(id.peerId);
    expect(ctx.name).toBe('Alice');
  });

  it('rejects a malformed token with a numeric close code', async () => {
    const err = await onAuthenticate({ token: 'not.a.jwt', documentName: 'board' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(typeof closeCodeFor(err)).toBe('number');
  });

  it('rejects a token signed with a different secret with a numeric close code', async () => {
    // Same shape, wrong signature — the exact case a rotated JWT_SECRET or a
    // restarted production server (random per-boot key) produces.
    const id = await issueIdentity('Alice');
    const [h, p] = id.token.split('.');
    const forged = `${h}.${p}.${'A'.repeat(43)}`;
    const err = await onAuthenticate({ token: forged, documentName: 'board' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(typeof closeCodeFor(err)).toBe('number');
  });

  it('rejects a missing token and an over-long room name', async () => {
    for (const data of [
      { token: undefined, documentName: 'board' },
      { token: 'x', documentName: 'n'.repeat(5000) },
    ]) {
      const err = await onAuthenticate(data).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(typeof closeCodeFor(err)).toBe('number');
    }
  });
});

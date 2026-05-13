/**
 * Identity issuer round-trip — issue a JWT and ensure verifyIdentity
 * accepts it and rejects tampered tokens.
 */
import { describe, it, expect } from 'vitest';
import { issueIdentity, verifyIdentity } from './identity.js';

describe('issueIdentity', () => {
  it('issues a token that round-trips through verifyIdentity', async () => {
    const id = await issueIdentity('Alice');
    expect(id.name).toBe('Alice');
    expect(id.peerId.startsWith('peer-')).toBe(true);
    const claims = await verifyIdentity(id.token);
    expect(claims.sub).toBe(id.peerId);
    expect(claims.name).toBe(id.name);
  });
  it('sanitizes display names', async () => {
    const id = await issueIdentity('  \u0000Bo b  ');
    expect(id.name).toBe('Bo b');
  });
  it('falls back to Guest', async () => {
    const id = await issueIdentity('');
    expect(id.name).toBe('Guest');
  });
  it('rejects bogus tokens', async () => {
    await expect(verifyIdentity('not.a.jwt')).rejects.toThrow();
  });
});

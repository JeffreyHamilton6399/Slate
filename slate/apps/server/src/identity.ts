/**
 * Anonymous identity issuance — clients call POST /api/identity and get back
 * a signed short-lived JWT that proves their displayName + peerId for the
 * lifetime of the session. Yjs auth hooks verify it on connect.
 */
import { SignJWT, jwtVerify } from 'jose';
import { sanitizeDisplayName } from '@slate/sync-protocol';
import { env } from './config.js';

const secretKey = new TextEncoder().encode(env.JWT_SECRET);

export interface IdentityClaims {
  /** Stable peer id (random ULID-like string). */
  sub: string;
  /** Sanitized display name. */
  name: string;
  /** Issued-at unix seconds. */
  iat: number;
  /** Expiration unix seconds. */
  exp: number;
}

export async function issueIdentity(displayName: string): Promise<{
  token: string;
  peerId: string;
  name: string;
}> {
  const name = sanitizeDisplayName(displayName || 'Guest') || 'Guest';
  const peerId = `peer-${randomId(20)}`;
  const token = await new SignJWT({ name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(peerId)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_TTL_SECONDS}s`)
    .sign(secretKey);
  return { token, peerId, name };
}

export async function verifyIdentity(token: string): Promise<IdentityClaims> {
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
  });
  if (typeof payload.sub !== 'string') throw new Error('missing sub');
  if (typeof payload.name !== 'string') throw new Error('missing name');
  return {
    sub: payload.sub,
    name: payload.name,
    iat: (payload.iat as number) ?? 0,
    exp: (payload.exp as number) ?? 0,
  };
}

function randomId(len: number): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnpqrstvwxyz23456789';
  let out = '';
  const buf = new Uint8Array(len);
  // Node 20+ has globalThis.crypto.
  globalThis.crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += alphabet[buf[i]! % alphabet.length];
  return out;
}

/**
 * Per-peer update rate limiting for the Yjs relay.
 *
 * A token bucket, not a fixed window: peers refill at
 * RATE_LIMIT_UPDATES_PER_SEC and may spend up to BURST_CAPACITY at once. The
 * burst matters because legitimate authoring is bursty — publishing an audio
 * sample writes one Yjs update per ~512KB chunk back to back, and a reconnect
 * replays a queue of them — while a fixed window refuses the 241st message of
 * a second even when the peer had been idle for the previous ten. The
 * sustained ceiling is unchanged; only the shape of what counts as "too fast"
 * is.
 *
 * Buckets are swept periodically: peer ids are minted fresh for every browser
 * session, so without eviction the map would grow for the whole life of the
 * process — one dead entry per tab that ever connected.
 */

import { RATE_LIMIT_UPDATES_PER_SEC } from '@slate/sync-protocol';

interface Bucket {
  /** Tokens left, fractional between refills. */
  tokens: number;
  /** When `tokens` was last refilled (ms). */
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Tokens added per millisecond of elapsed time. */
const REFILL_PER_MS = RATE_LIMIT_UPDATES_PER_SEC / 1000;
/** Ceiling on saved-up tokens — two seconds of budget. */
export const BURST_CAPACITY = RATE_LIMIT_UPDATES_PER_SEC * 2;
/** How often idle buckets are swept out of the map. */
export const SWEEP_INTERVAL_MS = 60_000;
/** A bucket idle this long is full by definition, so dropping it loses
 *  nothing: the peer's next message recreates it at full capacity. */
const IDLE_EVICT_MS = BURST_CAPACITY / REFILL_PER_MS;

let lastSweep = 0;

/** Drop buckets that have sat idle long enough to have refilled completely.
 *  checkRateLimit runs on every incoming message, so this stays off that hot
 *  path and walks the map once a minute. */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [peerId, bucket] of buckets) {
    if (now - bucket.updatedAt >= IDLE_EVICT_MS) buckets.delete(peerId);
  }
}

/** True while the peer is within budget; false once it exceeds it. */
export function checkRateLimit(peerId: string, now = Date.now()): boolean {
  sweep(now);
  const bucket = buckets.get(peerId);
  if (!bucket) {
    buckets.set(peerId, { tokens: BURST_CAPACITY - 1, updatedAt: now });
    return true;
  }
  // Refill for the time since the last message, capped at the burst ceiling.
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(BURST_CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Number of buckets currently held — the thing the sweep is there to bound. */
export function trackedPeerCount(): number {
  return buckets.size;
}

/** Test helper: forget every bucket and re-arm the sweep. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

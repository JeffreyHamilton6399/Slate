/**
 * Rate-limit bucket bookkeeping — the sustained ceiling, the burst allowance
 * that keeps legitimate bursty authoring (chunked audio publishes, a replayed
 * reconnect queue) from tripping it, and the eviction that stops the map from
 * growing one dead entry per browser tab that ever connected.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RATE_LIMIT_UPDATES_PER_SEC } from '@slate/sync-protocol';
import {
  BURST_CAPACITY,
  SWEEP_INTERVAL_MS,
  checkRateLimit,
  resetRateLimits,
  trackedPeerCount,
} from './rateLimit.js';

beforeEach(() => resetRateLimits());

describe('checkRateLimit', () => {
  it('allows a burst up to the bucket capacity, then refuses', () => {
    const t = 1_000_000;
    for (let i = 0; i < BURST_CAPACITY; i++) {
      expect(checkRateLimit('peer-a', t)).toBe(true);
    }
    expect(checkRateLimit('peer-a', t)).toBe(false);
  });

  it('refills at the sustained rate', () => {
    const t = 2_000_000;
    for (let i = 0; i <= BURST_CAPACITY; i++) checkRateLimit('peer-b', t);
    expect(checkRateLimit('peer-b', t)).toBe(false);
    // Half a second of refill buys half a second of budget, and no more.
    const half = RATE_LIMIT_UPDATES_PER_SEC / 2;
    for (let i = 0; i < half; i++) {
      expect(checkRateLimit('peer-b', t + 500)).toBe(true);
    }
    expect(checkRateLimit('peer-b', t + 500)).toBe(false);
  });

  it('lets a peer authoring at the sustained rate run indefinitely', () => {
    // 240 messages/second for 30 seconds — the ceiling, sent evenly.
    let t = 3_000_000;
    const step = 1000 / RATE_LIMIT_UPDATES_PER_SEC;
    for (let i = 0; i < RATE_LIMIT_UPDATES_PER_SEC * 30; i++) {
      expect(checkRateLimit('peer-steady', Math.round(t))).toBe(true);
      t += step;
    }
  });

  it('never saves up more than the burst capacity', () => {
    const t = 4_000_000;
    checkRateLimit('peer-idle', t);
    // Idle for an hour: the bucket refills to the cap, not beyond it.
    const later = t + 3_600_000;
    for (let i = 0; i < BURST_CAPACITY; i++) {
      expect(checkRateLimit('peer-idle', later)).toBe(true);
    }
    expect(checkRateLimit('peer-idle', later)).toBe(false);
  });

  it('budgets each peer separately', () => {
    const t = 5_000_000;
    for (let i = 0; i <= BURST_CAPACITY; i++) checkRateLimit('peer-c', t);
    expect(checkRateLimit('peer-c', t)).toBe(false);
    expect(checkRateLimit('peer-d', t)).toBe(true);
  });

  it('evicts idle buckets instead of growing without bound', () => {
    const t = 6_000_000;
    // A thousand one-shot peers, the shape of a thousand short browser visits.
    for (let i = 0; i < 1000; i++) checkRateLimit(`visitor-${i}`, t);
    expect(trackedPeerCount()).toBe(1000);

    // A single later call past the sweep interval clears the idle buckets.
    checkRateLimit('someone-new', t + SWEEP_INTERVAL_MS + 1);
    expect(trackedPeerCount()).toBe(1);
  });

  it('keeps a peer that is still spending its budget', () => {
    const t = 7_000_000;
    checkRateLimit('old-peer', t);
    const later = t + SWEEP_INTERVAL_MS + 1;
    // The sweep fires on this call; the live peer keeps talking through it.
    checkRateLimit('live-peer', later);
    checkRateLimit('live-peer', later + 100);
    expect(trackedPeerCount()).toBe(1);
    expect(checkRateLimit('live-peer', later + 200)).toBe(true);
  });
});

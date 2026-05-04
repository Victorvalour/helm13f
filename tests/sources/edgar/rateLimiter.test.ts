// Token-bucket rate limiter tests.
//
// Uses an injectable clock + sleep so tests are fully deterministic.

import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../../src/sources/edgar/rateLimiter.js';

/**
 * Test harness with a virtual clock. `advance(ms)` moves the clock forward
 * AND immediately resolves any sleep waiters whose deadline has passed.
 * This is enough to drive the bucket through any scenario without real time.
 */
function makeClock() {
  let t = 0;
  const waiters: Array<{ deadline: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ deadline: t + ms, resolve });
      }),
    advance: async (ms: number) => {
      t += ms;
      // Resolve waiters whose deadline has passed; allow the microtask queue
      // to drain after each so chained promises run.
      while (true) {
        const due = waiters.filter((w) => w.deadline <= t);
        if (due.length === 0) break;
        for (const w of due) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    pendingWaiters: () => waiters.length,
  };
}

describe('TokenBucket', () => {
  it('starts full and grants `capacity` immediate acquires', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({
      capacity: 10,
      refillPerSec: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    for (let i = 0; i < 10; i++) {
      await bucket.acquire();
    }
    expect(bucket.available()).toBeCloseTo(0, 5);
  });

  it('refills at the configured rate over time', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({
      capacity: 10,
      refillPerSec: 10,
      initialTokens: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(bucket.available()).toBe(0);
    await clock.advance(500);
    expect(bucket.available()).toBeCloseTo(5, 5);
    await clock.advance(1500);
    expect(bucket.available()).toBe(10); // capped at capacity
  });

  it('queues acquires beyond capacity and resolves them as tokens refill', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({
      capacity: 2,
      refillPerSec: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    const order: number[] = [];
    const p1 = bucket.acquire().then(() => order.push(1));
    const p2 = bucket.acquire().then(() => order.push(2));
    const p3 = bucket.acquire().then(() => order.push(3));
    const p4 = bucket.acquire().then(() => order.push(4));

    // First 2 should resolve from initial tokens. Drain microtasks to let
    // the .then(() => order.push) callbacks run after acquire() resolves.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(order).toEqual([1, 2]);

    // The 3rd needs 100ms (1 token at 10/s).
    await clock.advance(100);
    expect(order).toEqual([1, 2, 3]);

    // The 4th needs another 100ms.
    await clock.advance(100);
    expect(order).toEqual([1, 2, 3, 4]);

    await Promise.all([p1, p2, p3, p4]);
  });

  it('FIFO ordering across many concurrent waiters', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSec: 100, // 10ms per token
      initialTokens: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    const order: number[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        bucket.acquire().then(() => {
          order.push(i);
        }),
      );
    }

    for (let i = 0; i < 5; i++) {
      await clock.advance(10);
    }

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects invalid construction parameters', () => {
    expect(() => new TokenBucket({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new TokenBucket({ refillPerSec: 0 })).toThrow(/refillPerSec/);
    expect(() => new TokenBucket({ capacity: 5, initialTokens: -1 })).toThrow(/initialTokens/);
    expect(() => new TokenBucket({ capacity: 5, initialTokens: 6 })).toThrow(/initialTokens/);
  });
});

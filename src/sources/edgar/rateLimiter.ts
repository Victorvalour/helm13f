// Token-bucket rate limiter for EDGAR HTTP calls.
//
// SEC publishes a 10 requests/second limit shared across data.sec.gov and
// www.sec.gov. We funnel every call through a single bucket instance.
//
// Design choices:
//   - Capacity 10, refill 10/sec. Allows brief bursts up to capacity, then
//     paces continuous traffic at 10/s.
//   - In-memory only. The single ingestion worker on Railway runs ~daily;
//     cold-start "bursts" of 10 immediate requests are within SEC's policy,
//     so we don't persist counter state to disk.
//   - `now()` and `sleep()` are injectable for deterministic testing.
//   - acquire() is FIFO across concurrent waiters via a queue.

export interface TokenBucketOptions {
  /** Max tokens the bucket can hold. Default 10. */
  capacity?: number;
  /** Refill rate in tokens per second. Default 10. */
  refillPerSec?: number;
  /** Tokens at construction. Default = capacity (start full). */
  initialTokens?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  /**
   * Injectable sleep. Default uses setTimeout. Tests can swap to a
   * synchronous-ish promise that resolves on a fake clock.
   */
  sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  private tokens: number;
  private lastRefillAt: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: Waiter[] = [];
  private pumping = false;

  constructor(opts: TokenBucketOptions = {}) {
    this.capacity = opts.capacity ?? 10;
    this.refillPerSec = opts.refillPerSec ?? 10;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    if (this.capacity <= 0) {
      throw new Error('TokenBucket: capacity must be > 0');
    }
    if (this.refillPerSec <= 0) {
      throw new Error('TokenBucket: refillPerSec must be > 0');
    }
    this.tokens = opts.initialTokens ?? this.capacity;
    if (this.tokens < 0 || this.tokens > this.capacity) {
      throw new Error('TokenBucket: initialTokens out of range');
    }
    this.lastRefillAt = this.now();
  }

  /** Refill based on elapsed time since `lastRefillAt`. */
  private refill(): void {
    const t = this.now();
    const elapsedMs = t - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    const add = (elapsedMs / 1000) * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + add);
    this.lastRefillAt = t;
  }

  /**
   * Wait until a single token is available, then consume it.
   * Resolves in-order (FIFO) when multiple callers are waiting.
   *
   * Not declared `async` on purpose: a hand-built Promise here avoids an
   * extra microtask drain that confuses fine-grained ordering tests.
   */
  acquire(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      void this.pump();
    });
  }

  /** Drain the queue, waiting on the bucket between consumers. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          const w = this.queue.shift()!;
          w.resolve();
          continue;
        }
        // Need to wait for the next token. Compute wait in ms.
        const deficit = 1 - this.tokens;
        const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
        await this.sleep(waitMs);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Snapshot of the current token count (after refill). For tests / metrics. */
  available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Singleton bucket for the SEC EDGAR shared limit (10 req/s).
 * Use this for production code paths. Tests should construct their own.
 */
let edgarBucket: TokenBucket | null = null;
export function getEdgarBucket(): TokenBucket {
  if (!edgarBucket) {
    edgarBucket = new TokenBucket({ capacity: 10, refillPerSec: 10 });
  }
  return edgarBucket;
}

/** Test-only: reset the singleton between suites. */
export function resetEdgarBucketForTests(): void {
  edgarBucket = null;
}

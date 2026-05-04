// OpenFIGI v3 mapping client.
//
// Used as the secondary CUSIP→ticker resolver (primary: SEC company_tickers
// for issuer-side mapping, then OpenFIGI for everything else — depositary
// receipts, OTC names, etc.).
//
// Rate-limit policy (OpenFIGI published):
//   - With API key: 25 requests / 6 sec → 250/min, max 100 jobs per request.
//   - Without API key: 25 requests / minute, max 10 jobs per request.
// The constructor picks defaults based on whether `apiKey` is set.
//
// Retries:
//   - 429 honours Retry-After (cap 60s).
//   - 5xx exponential backoff with jitter, max 3 retries.
//   - 4xx (except 429) thrown immediately.

import { TokenBucket } from '../edgar/rateLimiter.js';
import type {
  OpenFigiClientOptions,
  OpenFigiHit,
  OpenFigiMappingJob,
  OpenFigiResponseEntry,
} from './types.js';

const ENDPOINT = 'https://api.openfigi.com/v3/mapping';
const MAX_RETRY_AFTER_MS = 60_000;

export class OpenFigiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenFigiError';
  }
}

export class OpenFigiHttpError extends OpenFigiError {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`OpenFIGI HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'OpenFigiHttpError';
  }
}

export class OpenFigiClient {
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly bucket: TokenBucket;
  private readonly maxJobsPerRequest: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OpenFigiClientOptions = {}) {
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    const requestsPerMinute = opts.requestsPerMinute ?? (this.apiKey ? 250 : 25);
    this.maxJobsPerRequest = opts.maxJobsPerRequest ?? (this.apiKey ? 100 : 10);
    // Convert per-minute to per-second for our token bucket.
    this.bucket = new TokenBucket({
      capacity: this.apiKey ? 25 : 5,
      refillPerSec: requestsPerMinute / 60,
    });
  }

  /**
   * Resolve a batch of CUSIPs to their primary US-listed ticker (when one
   * exists). Returns a Map keyed by the input CUSIP. CUSIPs with no
   * resolvable ticker map to `null`. Order-stable; safe to call with
   * any number of inputs (chunks internally to respect maxJobsPerRequest).
   */
  async mapCusips(cusips: readonly string[]): Promise<Map<string, OpenFigiHit | null>> {
    const result = new Map<string, OpenFigiHit | null>();
    if (cusips.length === 0) return result;
    const dedup = Array.from(new Set(cusips));
    const chunks = chunk(dedup, this.maxJobsPerRequest);
    for (const part of chunks) {
      const jobs: OpenFigiMappingJob[] = part.map((c) => ({
        idType: 'ID_CUSIP',
        idValue: c,
        exchCode: 'US',
      }));
      const res = await this.mappingRequest(jobs);
      for (let i = 0; i < part.length; i++) {
        const cusip = part[i]!;
        const entry = res[i];
        if (!entry || entry.error || !entry.data || entry.data.length === 0) {
          result.set(cusip, null);
          continue;
        }
        const hit = pickPrimaryUSEquity(entry.data);
        result.set(cusip, hit);
      }
    }
    return result;
  }

  /** Convenience: resolve a single CUSIP. */
  async mapCusip(cusip: string): Promise<OpenFigiHit | null> {
    const m = await this.mapCusips([cusip]);
    return m.get(cusip) ?? null;
  }

  private async mappingRequest(jobs: OpenFigiMappingJob[]): Promise<OpenFigiResponseEntry[]> {
    let attempt = 0;
    for (;;) {
      await this.bucket.acquire();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) headers['X-OPENFIGI-APIKEY'] = this.apiKey;
      const res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(jobs),
      });

      if (res.status === 200) {
        const text = await res.text();
        try {
          return JSON.parse(text) as OpenFigiResponseEntry[];
        } catch (err) {
          throw new OpenFigiError(`JSON parse failed: ${(err as Error).message}`);
        }
      }

      const body = await safeReadText(res);

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new OpenFigiHttpError(429, body);
        }
        const ra = parseRetryAfterMs(res.headers.get('retry-after'));
        const waitMs = Math.min(ra ?? this.backoffMs(attempt), MAX_RETRY_AFTER_MS);
        await this.sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt >= this.maxRetries) {
          throw new OpenFigiHttpError(res.status, body);
        }
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }

      throw new OpenFigiHttpError(res.status, body);
    }
  }

  private backoffMs(attempt: number): number {
    const exp = this.retryBaseMs * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * this.retryBaseMs);
    return exp + jitter;
  }
}

/**
 * Pick the most-useful hit for our purposes (single primary US-listed
 * equity). Strategy:
 *   1. Prefer exchCode === 'US' (composite US ticker).
 *   2. Then exchCode in NYSE/NASDAQ-family ('UN', 'UQ', 'UA', 'UR', 'UF').
 *   3. Otherwise the first hit.
 * Hits without a ticker are skipped.
 */
export function pickPrimaryUSEquity(hits: OpenFigiHit[]): OpenFigiHit | null {
  const tickered = hits.filter((h) => h.ticker && h.ticker.length > 0);
  if (tickered.length === 0) return null;
  const composite = tickered.find((h) => h.exchCode === 'US');
  if (composite) return composite;
  const usExch = new Set(['UN', 'UQ', 'UA', 'UR', 'UF', 'UV', 'UW']);
  const onUS = tickered.find((h) => h.exchCode && usExch.has(h.exchCode));
  if (onUS) return onUS;
  return tickered[0]!;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new OpenFigiError('chunk: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

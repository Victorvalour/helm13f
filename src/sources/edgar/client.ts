// EdgarClient — the only path through which Helm13F talks to SEC EDGAR.
//
// Calibration locks honoured here:
//   - Single rate-limited HTTP client (Phase 0 calibration 6).
//   - User-Agent header on every request (SEC requirement).
//   - Filer-named INFOTABLE filename discovered via index.json
//     (calibration 2 — see getFilingIndex / pickInfoTableFilename).
//
// Retries:
//   - 429 with Retry-After honoured (capped at 60s).
//   - 5xx exponential backoff with jitter, max 3 retries.
//   - 4xx (except 429) thrown immediately as EdgarHttpError.

import { type TokenBucket, getEdgarBucket } from './rateLimiter.js';
import type {
  EdgarCompanyTickers,
  EdgarFilingIndex,
  EdgarFullTextSearchResult,
  EdgarSubmissions,
  EdgarSubmissionsPage,
} from './types.js';

const DATA_HOST = 'https://data.sec.gov';
const ARCHIVES_HOST = 'https://www.sec.gov';
const FULLTEXT_HOST = 'https://efts.sec.gov';

export class EdgarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgarError';
  }
}

export class EdgarHttpError extends EdgarError {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`EDGAR HTTP ${status} on ${url}: ${body.slice(0, 200)}`);
    this.name = 'EdgarHttpError';
  }
}

export class EdgarNotFoundError extends EdgarHttpError {
  constructor(url: string, body: string) {
    super(404, url, body);
    this.name = 'EdgarNotFoundError';
  }
}

export interface EdgarClientOptions {
  /** Required. SEC mandates a real contact identifier. */
  userAgent: string;
  /** Optional. Defaults to the shared 10-req/s singleton. */
  rateLimiter?: TokenBucket;
  /** Optional. Defaults to global fetch. Tests inject a mock. */
  fetchImpl?: typeof fetch;
  /** Optional. Default 3. */
  maxRetries?: number;
  /** Optional. Default 250ms. Base for exponential backoff. */
  retryBaseMs?: number;
  /** Optional. Default 60_000ms. Cap on Retry-After honouring. */
  maxRetryAfterMs?: number;
  /** Optional. Injectable for tests. Default uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class EdgarClient {
  private readonly userAgent: string;
  private readonly rateLimiter: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: EdgarClientOptions) {
    if (!opts.userAgent || opts.userAgent.trim().length === 0) {
      throw new EdgarError(
        'EdgarClient: userAgent is required (SEC rejects requests without a real contact identifier).',
      );
    }
    this.userAgent = opts.userAgent;
    this.rateLimiter = opts.rateLimiter ?? getEdgarBucket();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 250;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  // ------------------------------------------------------------
  // Public endpoints
  // ------------------------------------------------------------

  /** GET https://data.sec.gov/submissions/CIK{paddedCIK}.json */
  async getSubmissions(cik: string | number): Promise<EdgarSubmissions> {
    const padded = padCik(cik);
    const url = `${DATA_HOST}/submissions/CIK${padded}.json`;
    return this.fetchJson<EdgarSubmissions>(url);
  }

  /**
   * GET https://data.sec.gov/submissions/{filename}.
   * `filename` comes from filings.files[].name in the prior page.
   */
  async getSubmissionsPage(filename: string): Promise<EdgarSubmissionsPage> {
    if (!/^[\w.-]+\.json$/.test(filename)) {
      throw new EdgarError(`getSubmissionsPage: invalid filename ${filename}`);
    }
    const url = `${DATA_HOST}/submissions/${filename}`;
    return this.fetchJson<EdgarSubmissionsPage>(url);
  }

  /** GET https://www.sec.gov/Archives/edgar/data/{CIK}/{accNoDashes}/index.json */
  async getFilingIndex(cik: string | number, accessionNumber: string): Promise<EdgarFilingIndex> {
    const cikNum = stripLeadingZeros(padCik(cik));
    const acc = accessionNoDashes(accessionNumber);
    const url = `${ARCHIVES_HOST}/Archives/edgar/data/${cikNum}/${acc}/index.json`;
    return this.fetchJson<EdgarFilingIndex>(url);
  }

  /**
   * GET https://www.sec.gov/Archives/edgar/data/{CIK}/{accNoDashes}/{filename}.
   * Returns the raw response body as text. Used for primary_doc.xml and the
   * filer-named InfoTable XML.
   */
  async getFilingFile(
    cik: string | number,
    accessionNumber: string,
    filename: string,
  ): Promise<string> {
    if (!/^[\w./-]+$/.test(filename)) {
      throw new EdgarError(`getFilingFile: invalid filename ${filename}`);
    }
    const cikNum = stripLeadingZeros(padCik(cik));
    const acc = accessionNoDashes(accessionNumber);
    const url = `${ARCHIVES_HOST}/Archives/edgar/data/${cikNum}/${acc}/${filename}`;
    return this.fetchText(url);
  }

  /** GET https://www.sec.gov/files/company_tickers.json */
  async getCompanyTickers(): Promise<EdgarCompanyTickers> {
    const url = `${ARCHIVES_HOST}/files/company_tickers.json`;
    return this.fetchJson<EdgarCompanyTickers>(url);
  }

  /**
   * GET https://efts.sec.gov/LATEST/search-index?q=...&forms=...
   * Used during universe expansion (Phase 3.8).
   */
  async fullTextSearch(
    query: string,
    opts: { forms?: string[]; from?: number; size?: number } = {},
  ): Promise<EdgarFullTextSearchResult> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (opts.forms && opts.forms.length > 0) {
      params.set('forms', opts.forms.join(','));
    }
    if (typeof opts.from === 'number') params.set('from', String(opts.from));
    if (typeof opts.size === 'number') params.set('size', String(opts.size));
    const url = `${FULLTEXT_HOST}/LATEST/search-index?${params.toString()}`;
    return this.fetchJson<EdgarFullTextSearchResult>(url);
  }

  // ------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------

  private async fetchJson<T>(url: string): Promise<T> {
    const text = await this.fetchText(url);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new EdgarError(`EDGAR JSON parse failed for ${url}: ${(err as Error).message}`);
    }
  }

  private async fetchText(url: string): Promise<string> {
    let attempt = 0;
    for (;;) {
      await this.rateLimiter.acquire();
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          'Accept-Encoding': 'gzip, deflate',
          Accept: '*/*',
        },
      });

      if (res.status === 200) {
        return await res.text();
      }

      const body = await safeReadText(res);

      if (res.status === 404) {
        throw new EdgarNotFoundError(url, body);
      }

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new EdgarHttpError(429, url, body);
        }
        const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
        const waitMs = Math.min(retryAfter ?? this.backoffMs(attempt), this.maxRetryAfterMs);
        await this.sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt >= this.maxRetries) {
          throw new EdgarHttpError(res.status, url, body);
        }
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }

      // Other 4xx — non-retryable.
      throw new EdgarHttpError(res.status, url, body);
    }
  }

  private backoffMs(attempt: number): number {
    // Exponential with jitter: base * 2^attempt + [0, base) jitter.
    const exp = this.retryBaseMs * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * this.retryBaseMs);
    return exp + jitter;
  }
}

// ------------------------------------------------------------
// Helpers (exported for parser/ingestion + tests)
// ------------------------------------------------------------

/** Pad a CIK (string or number) to 10 digits with leading zeros. */
export function padCik(cik: string | number): string {
  const s = typeof cik === 'number' ? String(cik) : cik.replace(/\D/g, '');
  if (!s) throw new EdgarError(`padCik: empty CIK`);
  if (s.length > 10) throw new EdgarError(`padCik: CIK too long: ${cik}`);
  return s.padStart(10, '0');
}

/** Strip leading zeros for the Archives path component. */
export function stripLeadingZeros(padded: string): string {
  return padded.replace(/^0+/, '') || '0';
}

/** Convert "0001193125-26-054580" to "000119312526054580". */
export function accessionNoDashes(accessionNumber: string): string {
  if (!/^[0-9]{10}-[0-9]{2}-[0-9]{6}$/.test(accessionNumber)) {
    throw new EdgarError(`accessionNoDashes: invalid accession number ${accessionNumber}`);
  }
  return accessionNumber.replace(/-/g, '');
}

/**
 * Pick the InfoTable XML filename from a filing's index.json directory listing.
 * Strategy: the InfoTable is the only `.xml` file that is NOT `primary_doc.xml`.
 * If multiple candidates exist (rare; sub-filings), pick the largest by `size`.
 */
export function pickInfoTableFilename(index: EdgarFilingIndex): string | null {
  const xmls = index.directory.item.filter(
    (it) => it.name.toLowerCase().endsWith('.xml') && it.name.toLowerCase() !== 'primary_doc.xml',
  );
  if (xmls.length === 0) return null;
  if (xmls.length === 1) return xmls[0]!.name;
  // Tie-break by size descending.
  const sorted = [...xmls].sort(
    (a, b) => parseInt(b.size || '0', 10) - parseInt(a.size || '0', 10),
  );
  return sorted[0]!.name;
}

/** Parse the Retry-After header (seconds, or HTTP-date). Returns ms or null. */
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

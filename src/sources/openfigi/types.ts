// OpenFIGI v3 mapping API request/response types.
// Spec: https://www.openfigi.com/api/documentation

/** A single mapping job (we only use idType=ID_CUSIP). */
export interface OpenFigiMappingJob {
  idType: 'ID_CUSIP' | 'ID_ISIN' | 'TICKER' | 'COMPOSITE_ID_BB_GLOBAL';
  idValue: string;
  /**
   * Optional exchCode filter. When set to 'US' OpenFIGI returns the
   * US-composite ticker; otherwise individual exchange tickers may
   * appear in the data array.
   */
  exchCode?: string;
  /** Optional security-type filter (e.g. "Common Stock"). */
  securityType?: string;
  /** Optional security-type 2 filter (e.g. "Common Stock"). */
  securityType2?: string;
  /** Optional market-sector filter. */
  marketSecDes?: string;
}

/** One returned hit from the OpenFIGI mapping API. */
export interface OpenFigiHit {
  figi: string;
  name: string | null;
  ticker: string | null;
  exchCode: string | null;
  compositeFIGI: string | null;
  uniqueID: string | null;
  securityType: string | null;
  marketSector: string | null;
  shareClassFIGI: string | null;
  uniqueIDFutOpt: string | null;
  securityType2: string | null;
  securityDescription: string | null;
}

/** Element of the top-level OpenFIGI mapping response array. */
export type OpenFigiResponseEntry =
  | { data: OpenFigiHit[]; warning?: string; error?: undefined }
  | { error: string; data?: undefined; warning?: undefined }
  | { warning: string; data?: undefined; error?: undefined };

export interface OpenFigiClientOptions {
  /**
   * Optional. When provided, bumps rate limits and per-request batch size.
   * Generated at https://www.openfigi.com/api.
   */
  apiKey?: string;
  /** Defaults to global fetch. Tests inject a mock. */
  fetchImpl?: typeof fetch;
  /** Optional. Default 3. */
  maxRetries?: number;
  /** Optional. Default 500ms. Base for exponential backoff. */
  retryBaseMs?: number;
  /** Optional. Injectable for tests. Default uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional override for the per-minute rate limit. Defaults follow
   * OpenFIGI's published policy: 25/min unauth, 250/min with key.
   */
  requestsPerMinute?: number;
  /**
   * Optional override for max jobs per HTTP request. Defaults: 10
   * unauth, 100 with key.
   */
  maxJobsPerRequest?: number;
}

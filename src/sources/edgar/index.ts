// Barrel export for the EDGAR source module.
export {
  EdgarClient,
  EdgarError,
  EdgarHttpError,
  EdgarNotFoundError,
  padCik,
  stripLeadingZeros,
  accessionNoDashes,
  pickInfoTableFilename,
} from './client.js';
export type { EdgarClientOptions } from './client.js';
export { TokenBucket, getEdgarBucket, resetEdgarBucketForTests } from './rateLimiter.js';
export type { TokenBucketOptions } from './rateLimiter.js';
export type {
  EdgarSubmissions,
  EdgarSubmissionsRecent,
  EdgarSubmissionsPage,
  EdgarFilingIndex,
  EdgarCompanyTickers,
  EdgarFullTextSearchResult,
} from './types.js';

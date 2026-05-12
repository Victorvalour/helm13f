// Barrel for the ingestion layer.

export { discoverFilingsForFiler, recentQuarterEnds, type DiscoveredFiling } from './discover.js';

export { fetchAndParseFiling, FilingFetchError, type FetchedFiling } from './parse.js';

export { persistFiling, type PersistFilingOptions, type PersistFilingResult } from './upsert.js';

export { runIngestion, type IngestionRunInput, type IngestionRunSummary } from './runner.js';

export { planBackfill, runBackfill, type BackfillOptions, type BackfillPlan } from './backfill.js';

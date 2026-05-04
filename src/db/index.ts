// Barrel exports for the db layer.

export {
  createPgDatabase,
  DbError,
  type Database,
  type QueryRunner,
  type PgDatabaseOptions,
} from './pool.js';

export {
  migrate,
  loadMigrationFiles,
  listAppliedMigrations,
  MIGRATIONS_TABLE_NAME,
  type MigrateOptions,
  type MigrationApplied,
  type MigrationFile,
} from './migrate.js';

export { FilersRepo, normalize as normalizeFilerName } from './repos/filers.js';
export type { FilerRow, FilerUpsert } from './repos/filers.js';

export { FilingsRepo } from './repos/filings.js';
export type { FilingRow, FilingUpsert } from './repos/filings.js';

export { HoldingsRepo } from './repos/holdings.js';
export type { HoldingRow, HoldingUpsert } from './repos/holdings.js';

export { CusipTickerMapRepo } from './repos/cusipTickerMap.js';

export { DeltaCacheRepo } from './repos/deltaCache.js';
export type { DeltaCacheEntry } from './repos/deltaCache.js';

export { IngestionLogRepo } from './repos/ingestionLog.js';
export type { IngestionLogRow, IngestionRunKind } from './repos/ingestionLog.js';

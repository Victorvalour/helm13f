// `filers` table repository.

import type { QueryRunner } from '../pool.js';

export interface FilerRow {
  filerCIK: string;
  filerName: string;
  normalizedName: string;
  displayName: string | null;
  isSuperinvestor: boolean;
  superinvestorTier: 'legendary' | 'well-known' | 'notable' | null;
  primaryStrategy: string | null;
  aliases: string[];
  lastSeenAt: Date | null;
}

export interface FilerUpsert {
  filerCIK: string;
  filerName: string;
  /** Optional override; defaults to normalize(filerName). */
  normalizedName?: string;
  displayName?: string | null;
  isSuperinvestor?: boolean;
  superinvestorTier?: 'legendary' | 'well-known' | 'notable' | null;
  primaryStrategy?: string | null;
  aliases?: string[];
  /** Stamp `last_seen_at = $1` on upsert; defaults to NOW(). */
  seenAt?: Date;
}

export class FilersRepo {
  constructor(private readonly db: QueryRunner) {}

  async getByCik(cik: string): Promise<FilerRow | null> {
    const r = await this.db.query<DbFilerRow>(
      `SELECT filer_cik, filer_name, normalized_name, display_name,
              is_superinvestor, superinvestor_tier, primary_strategy,
              aliases, last_seen_at
       FROM filers WHERE filer_cik = $1`,
      [cik],
    );
    return r.rows[0] ? rowToFiler(r.rows[0]) : null;
  }

  /**
   * Insert-or-update by primary key. Honours the SQL CHECK pairing
   * is_superinvestor ↔ superinvestor_tier; callers MUST pass both
   * (or both as default false/null).
   */
  async upsert(input: FilerUpsert): Promise<FilerRow> {
    const isSuper = input.isSuperinvestor ?? false;
    const tier = input.superinvestorTier ?? null;
    if (isSuper && tier === null) {
      throw new Error('FilersRepo.upsert: superinvestorTier required when isSuperinvestor=true');
    }
    if (!isSuper && tier !== null) {
      throw new Error(
        'FilersRepo.upsert: superinvestorTier must be null when isSuperinvestor=false',
      );
    }
    const normalized = input.normalizedName ?? normalize(input.filerName);
    const aliases = JSON.stringify(input.aliases ?? []);
    const seenAt = input.seenAt ?? new Date();
    const r = await this.db.query<DbFilerRow>(
      `INSERT INTO filers (
         filer_cik, filer_name, normalized_name, display_name,
         is_superinvestor, superinvestor_tier, primary_strategy,
         aliases, last_seen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (filer_cik) DO UPDATE SET
         filer_name        = EXCLUDED.filer_name,
         normalized_name   = EXCLUDED.normalized_name,
         display_name      = COALESCE(EXCLUDED.display_name, filers.display_name),
         is_superinvestor  = EXCLUDED.is_superinvestor,
         superinvestor_tier = EXCLUDED.superinvestor_tier,
         primary_strategy  = COALESCE(EXCLUDED.primary_strategy, filers.primary_strategy),
         aliases           = EXCLUDED.aliases,
         last_seen_at      = EXCLUDED.last_seen_at,
         updated_at        = NOW()
       RETURNING filer_cik, filer_name, normalized_name, display_name,
                 is_superinvestor, superinvestor_tier, primary_strategy,
                 aliases, last_seen_at`,
      [
        input.filerCIK,
        input.filerName,
        normalized,
        input.displayName ?? null,
        isSuper,
        tier,
        input.primaryStrategy ?? null,
        aliases,
        seenAt,
      ],
    );
    return rowToFiler(r.rows[0]!);
  }

  /** List the curated superinvestor roster (for E3 list_superinvestors). */
  async listSuperinvestors(
    filter: {
      tier?: 'legendary' | 'well-known' | 'notable';
      strategySubstring?: string;
    } = {},
  ): Promise<FilerRow[]> {
    const conds: string[] = ['is_superinvestor = TRUE'];
    const params: unknown[] = [];
    if (filter.tier) {
      params.push(filter.tier);
      conds.push(`superinvestor_tier = $${params.length}`);
    }
    if (filter.strategySubstring) {
      params.push(`%${filter.strategySubstring.toLowerCase()}%`);
      conds.push(`LOWER(primary_strategy) LIKE $${params.length}`);
    }
    const r = await this.db.query<DbFilerRow>(
      `SELECT filer_cik, filer_name, normalized_name, display_name,
              is_superinvestor, superinvestor_tier, primary_strategy,
              aliases, last_seen_at
       FROM filers
       WHERE ${conds.join(' AND ')}
       ORDER BY
         CASE superinvestor_tier
           WHEN 'legendary' THEN 1
           WHEN 'well-known' THEN 2
           WHEN 'notable' THEN 3
         END,
         COALESCE(display_name, filer_name) ASC`,
      params,
    );
    return r.rows.map(rowToFiler);
  }
}

interface DbFilerRow {
  filer_cik: string;
  filer_name: string;
  normalized_name: string;
  display_name: string | null;
  is_superinvestor: boolean;
  superinvestor_tier: 'legendary' | 'well-known' | 'notable' | null;
  primary_strategy: string | null;
  aliases: string[];
  last_seen_at: Date | null;
}

function rowToFiler(r: DbFilerRow): FilerRow {
  return {
    filerCIK: r.filer_cik,
    filerName: r.filer_name,
    normalizedName: r.normalized_name,
    displayName: r.display_name,
    isSuperinvestor: r.is_superinvestor,
    superinvestorTier: r.superinvestor_tier,
    primaryStrategy: r.primary_strategy,
    aliases: r.aliases,
    lastSeenAt: r.last_seen_at,
  };
}

/** Lower-cased, whitespace-collapsed, punctuation-stripped form for fuzzy match. */
export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"`!?;:()&]/g, '')
    .replace(
      /\b(llc|lp|inc|ltd|lp\.|llc\.|inc\.|ltd\.|corporation|corp|company|co|capital|management|mgmt|partners|fund|funds)\b/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

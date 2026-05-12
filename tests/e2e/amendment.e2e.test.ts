// E2E: 13F-HR/A amendment handling against real Postgres.
// Verifies that ingesting an amendment for the same (filer, period) as
// an existing 13F-HR (a) sets supersededByAccession on the original,
// (b) leaves the amendment as the only "active" filing for the period.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { persistFiling } from '../../src/ingestion/index.js';
import { FilingsRepo } from '../../src/db/index.js';
import type { FetchedFiling } from '../../src/ingestion/index.js';
import type { ParsedPrimaryDoc } from '../../src/parser/index.js';
import { connectAndMigrate, type E2EHarness } from './setup.js';
import { makeStubResolver } from './stub-resolver.js';

let harness: E2EHarness | null;

beforeAll(async () => {
  harness = await connectAndMigrate();
});

afterAll(async () => {
  if (harness) await harness.close();
});

beforeEach(async () => {
  if (harness) await harness.reset();
});

function makeFiling(opts: {
  filerCIK: string;
  submissionType: '13F-HR' | '13F-HR/A';
  isAmendment: boolean;
  filerName: string;
  accession: string;
}): FetchedFiling {
  const primaryDoc: ParsedPrimaryDoc = {
    submissionType: opts.submissionType,
    isAmendment: opts.isAmendment,
    filerCIK: opts.filerCIK,
    filerName: opts.filerName,
    periodOfReport: '2025-12-31',
    reportType: '13F HOLDINGS REPORT',
    signatureDate: '2026-02-17',
    tableEntryTotal: 1,
    tableValueTotalRaw: 1_000_000_000,
    otherIncludedManagers: [],
    isConfidentialOmitted: false,
  };
  return {
    primaryDoc,
    holdings: [
      {
        cusip: '037833100',
        putCall: null,
        nameOfIssuer: 'APPLE INC',
        titleOfClass: 'COM',
        shares: 100n,
        valueRaw: 20_000n,
        sshPrnamtType: 'SH',
        investmentDiscretion: 'SOLE',
        votingAuthority: { sole: 100n, shared: 0n, none: 0n },
        sourceRowCount: 1,
      },
    ],
    bookValueUSD: 1_000_000_000n,
    valueScale: 'USD',
    primaryDocURL: `https://example/${opts.accession}/primary_doc.xml`,
    infoTableURL: `https://example/${opts.accession}/info.xml`,
    infoTableFilename: 'info.xml',
  };
}

describe.skipIf(!process.env['DATABASE_URL'])('e2e — amendment handling', () => {
  it('13F-HR/A supersedes the prior 13F-HR for the same (filer, period)', async () => {
    if (!harness) return;
    const resolver = makeStubResolver();

    // First: original 13F-HR.
    await persistFiling(
      harness.db,
      '0001067983',
      'ACC-ORIGINAL',
      '2026-02-17',
      makeFiling({
        filerCIK: '0001067983',
        submissionType: '13F-HR',
        isAmendment: false,
        filerName: 'BERKSHIRE HATHAWAY INC',
        accession: 'ACC-ORIGINAL',
      }),
      resolver,
    );

    // Then: amendment.
    const result = await persistFiling(
      harness.db,
      '0001067983',
      'ACC-AMENDMENT',
      '2026-02-20',
      makeFiling({
        filerCIK: '0001067983',
        submissionType: '13F-HR/A',
        isAmendment: true,
        filerName: 'BERKSHIRE HATHAWAY INC',
        accession: 'ACC-AMENDMENT',
      }),
      resolver,
    );

    expect(result.isAmendment).toBe(true);
    expect(result.superseded).toBe('ACC-ORIGINAL');

    // Original should now have supersededByAccession = 'ACC-AMENDMENT'.
    const filingsRepo = new FilingsRepo(harness.db);
    const orig = await filingsRepo.getByAccession('ACC-ORIGINAL');
    expect(orig!.supersededByAccession).toBe('ACC-AMENDMENT');

    // getActive returns the amendment, not the original.
    const active = await filingsRepo.getActive('0001067983', '2025-12-31');
    expect(active!.accessionNumber).toBe('ACC-AMENDMENT');
    expect(active!.isAmendment).toBe(true);
  });

  it('does not supersede when no prior 13F-HR exists for the period (amendment first)', async () => {
    if (!harness) return;
    const resolver = makeStubResolver();
    const result = await persistFiling(
      harness.db,
      '0001067983',
      'ACC-LONE-AMENDMENT',
      '2026-02-17',
      makeFiling({
        filerCIK: '0001067983',
        submissionType: '13F-HR/A',
        isAmendment: true,
        filerName: 'BERKSHIRE HATHAWAY INC',
        accession: 'ACC-LONE-AMENDMENT',
      }),
      resolver,
    );
    expect(result.isAmendment).toBe(true);
    expect(result.superseded).toBeNull();
  });
});

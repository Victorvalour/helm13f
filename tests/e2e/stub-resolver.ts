// Stub CUSIP resolver for e2e — no OpenFIGI calls, no real ticker
// resolution. Every CUSIP maps to a deterministic synthetic ticker so
// the holdings.ticker column is populated and ticker-axis queries
// work without hitting an external API.

import {
  CusipResolver,
  InMemoryCusipCache,
  type CusipRecord,
} from '../../src/sources/openfigi/index.js';
import type { OpenFigiClient, OpenFigiHit } from '../../src/sources/openfigi/index.js';

/** Maps every CUSIP to a synthetic ticker `T-<first6>`. */
class SyntheticFigi {
  mapCusips(cusips: readonly string[]): Promise<Map<string, OpenFigiHit | null>> {
    const out = new Map<string, OpenFigiHit | null>();
    for (const c of cusips) {
      out.set(c, {
        figi: `BBG-${c}`,
        name: `ISSUER-${c.slice(0, 4)}`,
        ticker: `T-${c.slice(0, 6)}`,
        exchCode: 'US',
        compositeFIGI: null,
        uniqueID: null,
        securityType: 'Common Stock',
        marketSector: 'Equity',
        shareClassFIGI: null,
        uniqueIDFutOpt: null,
        securityType2: null,
        securityDescription: null,
      });
    }
    return Promise.resolve(out);
  }
  mapCusip(cusip: string): Promise<OpenFigiHit | null> {
    return this.mapCusips([cusip]).then((m) => m.get(cusip) ?? null);
  }
}

export function makeStubResolver(): CusipResolver {
  return new CusipResolver(
    new InMemoryCusipCache(),
    new SyntheticFigi() as unknown as OpenFigiClient,
  );
}

/** Override a record set manually (used to set up specific ticker mappings
 *  for ticker-axis query tests). Returns a CusipRecord for direct cache seeding. */
export function syntheticRecord(cusip: string, ticker: string): CusipRecord {
  return {
    cusip,
    ticker,
    issuerName: `ISSUER-${cusip.slice(0, 4)}`,
    source: 'openfigi',
    lastVerifiedAt: new Date(),
  };
}

// Loader for /superinvestors/superinvestors.json.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RosterEntry } from './filer.js';

export const ROSTER_PATH = join(process.cwd(), 'superinvestors', 'superinvestors.json');

export class RosterLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterLoadError';
  }
}

interface RosterFile {
  entries: Array<{
    cik: string;
    displayName: string;
    edgarName: string;
    aliases: string[];
    superinvestorTier?: 'legendary' | 'well-known' | 'notable';
    primaryStrategy?: string | null;
  }>;
}

/** Load the curated roster from disk. Validates the basic shape. */
export async function loadRoster(path: string = ROSTER_PATH): Promise<RosterEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new RosterLoadError(`failed to read roster at ${path}: ${(err as Error).message}`);
  }
  let parsed: RosterFile;
  try {
    parsed = JSON.parse(text) as RosterFile;
  } catch (err) {
    throw new RosterLoadError(`roster is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new RosterLoadError('roster: top-level "entries" array is missing');
  }
  for (const e of parsed.entries) {
    if (!e.cik || !/^[0-9]{10}$/.test(e.cik)) {
      throw new RosterLoadError(`roster entry has invalid CIK: ${JSON.stringify(e.cik)}`);
    }
    if (!e.displayName || !e.edgarName) {
      throw new RosterLoadError(`roster entry ${e.cik} missing displayName or edgarName`);
    }
    if (!Array.isArray(e.aliases)) {
      throw new RosterLoadError(`roster entry ${e.cik} aliases must be an array`);
    }
  }
  return parsed.entries.map((e) => {
    const out: RosterEntry = {
      cik: e.cik,
      displayName: e.displayName,
      edgarName: e.edgarName,
      aliases: e.aliases,
      primaryStrategy: e.primaryStrategy ?? null,
    };
    if (e.superinvestorTier) out.superinvestorTier = e.superinvestorTier;
    return out;
  });
}

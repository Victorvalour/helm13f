// Barrel for the resolution layer.
export { levenshtein, similarity } from './levenshtein.js';
export {
  FilerResolver,
  normalize as normalizeFilerName,
  tokenise,
  type FilerResolution,
  type FilerResolverOptions,
  type ResolverCandidate,
  type RosterEntry,
} from './filer.js';
export { loadRoster, ROSTER_PATH } from './roster.js';

// Barrel export for the 13F-HR parser module.
export { parsePrimaryDoc, PrimaryDocParseError } from './primaryDoc.js';
export { parseInfoTable, InfoTableParseError } from './infoTable.js';
export {
  detectValueScale,
  normalizeValueToUSD,
  ValueScaleError,
  VALUE_SCALE_BOUNDARY_FILED_AT,
} from './valueScale.js';
export type {
  ParsedPrimaryDoc,
  ParsedOtherManager,
  ParsedInfoTable,
  RawInfoTableRow,
  AggregatedHolding,
  ValueScale,
} from './types.js';

// Barrel for the domain layer (pure deterministic computations).

export {
  convictionTier,
  computePctOfBook,
  CONVICTION_THRESHOLDS,
  ConvictionInputError,
  type ConvictionTier,
} from './conviction.js';

export {
  classifyDelta,
  shareDeltaPct,
  ADD_THRESHOLD_PCT,
  TRIM_THRESHOLD_PCT,
  DeltaInputError,
  type DeltaState,
  type DeltaType,
} from './delta.js';

export {
  detectCluster,
  tierFromCount,
  ClusterInputError,
  type ClusterDetectionResult,
  type ClusterEventInput,
  type ClusterEventOutput,
  type ClusterEventType,
  type ClusterSignalOutput,
  type ClusterTier,
} from './cluster.js';

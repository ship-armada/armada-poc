// ABOUTME: Entry point for the crowdfund indexer package.
// ABOUTME: Exports the initial data contracts and pure ingestion helpers while the service is built incrementally.

export { loadIndexerConfig } from './config.js'
export type { IndexerConfig } from './config.js'

export {
  SNAPSHOT_SCHEMA_VERSION,
} from './types.js'
export type {
  BlockRange,
  CrowdfundSnapshot,
  CursorState,
  IndexedRawLog,
  IndexerHealth,
  IndexerHealthStatus,
  IngestRangeRecord,
  IngestRangeStatus,
  ReconciliationResult,
  SnapshotMetadata,
} from './types.js'

export {
  createRangeDigest,
  findFirstGap,
  getContiguousVerifiedCursor,
  getLogIdentity,
  getRepairRanges,
} from './ingest/ranges.js'

export {
  backfillVerifiedRanges,
  planBackfillRanges,
} from './ingest/backfill.js'
export type {
  BackfillInput,
  BackfillResult,
  PlanBackfillRangesInput,
} from './ingest/backfill.js'

export {
  createJsonRpcRangeProvider,
  fetchIndexedLogs,
  repairRanges,
  stageRange,
  verifyRange,
} from './ingest/rpc.js'
export type {
  RangeLogProvider,
  RangePipelineConfig,
  RepairRangesInput,
  RpcLog,
  StageRangeInput,
  VerifyRangeInput,
} from './ingest/rpc.js'

export { buildHealth } from './api/health.js'
export type { BuildHealthInput } from './api/health.js'
export { createIndexerApi } from './api/server.js'
export type { CreateIndexerApiOptions } from './api/server.js'

export { createReadableCrowdfundContract, deriveGraphAggregateStats, reconcileSnapshot } from './reconcile/contract.js'
export type {
  CrowdfundReadable,
  EstimatedCappedDemandRead,
  GraphAggregateStats,
  HopStatsRead,
  ReconcileSnapshotInput,
} from './reconcile/contract.js'

export { buildSnapshot } from './snapshots/build.js'
export type { BuildSnapshotInput } from './snapshots/build.js'
export { stableStringify, toJsonValue } from './snapshots/json.js'
export { publishSnapshot, publishSnapshotToObjectStorage } from './snapshots/publish.js'
export type { ObjectStorageClient, ObjectStoragePublishOptions, PublishSnapshotResult } from './snapshots/publish.js'

export { createEmptyStoreData, FileIndexerStore } from './db/fileStore.js'
export type { FileStoreOptions } from './db/fileStore.js'
export { createIndexerStore } from './db/createStore.js'
export type { CreateIndexerStoreOptions, IndexerStoreBackend } from './db/createStore.js'
export { POSTGRES_SCHEMA_SQL, PostgresIndexerStore } from './db/postgresStore.js'
export type { PostgresStoreOptions } from './db/postgresStore.js'
export type { IndexerStore } from './db/store.js'

export {
  formatStatus,
  getStatusHealth,
  parseCliArgs,
  runReadOnlyCommand,
} from './cli/commands.js'
export type { CliCommand, CliCommandResult, ParsedCliArgs } from './cli/commands.js'

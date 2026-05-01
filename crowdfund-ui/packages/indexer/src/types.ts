// ABOUTME: Shared data contracts for indexed crowdfund snapshots, health, and ingestion ranges.
// ABOUTME: Defines the API-facing shapes before persistence or transport details are added.

import type { CrowdfundEvent } from '../../shared/src/lib/events.js'
import type { CrowdfundGraph } from '../../shared/src/lib/graph.js'

export const SNAPSHOT_SCHEMA_VERSION = 1

export type IngestRangeStatus =
  | 'pending'
  | 'staged'
  | 'verified'
  | 'failed'
  | 'suspicious'

export type IndexerHealthStatus =
  | 'healthy'
  | 'stale'
  | 'degraded'
  | 'unhealthy'
  | 'unavailable'

export interface BlockRange {
  fromBlock: number
  toBlock: number
}

export interface IndexedRawLog {
  chainId: number
  contractAddress: string
  blockNumber: number
  blockHash: string
  transactionHash: string
  logIndex: number
  topics: readonly string[]
  data: string
}

export interface IngestRangeRecord extends BlockRange {
  status: IngestRangeStatus
  provider: string
  attempts: number
  logCount: number
  digest: string | null
  fetchedAt: string | null
  verifiedAt: string | null
  lastError: string | null
  // ISO timestamp at which this range becomes eligible for the next auto-repair attempt.
  // Null means "no constraint, retry now". Set by the auto-reconcile loop after a failed
  // or suspicious verification to enforce exponential backoff.
  nextRetryAt: string | null
}

export interface CursorState {
  deployBlock: number
  confirmationDepth: number
  overlapWindow: number
  chainHead: number
  confirmedHead: number
  ingestedCursor: number
  verifiedCursor: number
}

export interface ReconciliationResult {
  status: 'pending' | 'passed' | 'failed'
  checkedBlock: number | null
  provider: string | null
  checkedAt: string | null
  mismatches: readonly string[]
}

export interface SnapshotMetadata {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  chainId: number
  contractAddress: string
  deployBlock: number
  verifiedBlock: number
  verifiedBlockHash: string
  snapshotHash: string
  generatedAt: string
  reconciliation: ReconciliationResult
}

export interface CrowdfundSnapshot {
  metadata: SnapshotMetadata
  events: readonly CrowdfundEvent[]
  graph: CrowdfundGraph
}

export interface IndexerHealth {
  status: IndexerHealthStatus
  chainHead: number
  confirmedHead: number
  ingestedCursor: number
  verifiedCursor: number
  lagBlocks: number
  lastIngestedAt: string | null
  lastVerifiedAt: string | null
  lastReconciledAt: string | null
  hasGaps: boolean
  gapRanges: readonly BlockRange[]
  // Subset of gapRanges that have hit the auto-repair attempt limit and require
  // operator intervention (e.g. `npm run crowdfund:indexer:cli -- repair`).
  // Empty array does NOT mean no gaps — auto-repair may still be retrying them.
  gapsRequiringIntervention: readonly BlockRange[]
  lastError: string | null
  latestSnapshotHash: string | null
  latestStaticSnapshotUrl: string | null
}

export interface IndexerStoreData {
  cursor: CursorState
  ranges: readonly IngestRangeRecord[]
  rawLogs: readonly IndexedRawLog[]
  lastIngestedAt: string | null
  lastVerifiedAt: string | null
  lastReconciledAt: string | null
  lastError: string | null
  latestSnapshotHash: string | null
  latestStaticSnapshotUrl: string | null
}

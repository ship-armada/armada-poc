// ABOUTME: Builds verified crowdfund snapshots from persisted raw logs.
// ABOUTME: Reconstructs events and graph state, then computes deterministic snapshot metadata.

import { createHash } from 'node:crypto'
import { parseCrowdfundEvents } from '../../../shared/src/lib/events.js'
import { buildGraph } from '../../../shared/src/lib/graph.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../types.js'
import { stableStringify } from './json.js'
import type {
  CrowdfundSnapshot,
  IndexedRawLog,
  IndexerStoreData,
  ReconciliationResult,
  SnapshotMetadata,
} from '../types.js'

const ZERO_BLOCK_HASH = `0x${'00'.repeat(32)}`

export interface BuildSnapshotInput {
  data: IndexerStoreData
  chainId: number
  contractAddress: string
  reconciliation?: ReconciliationResult
  verifiedBlockHash?: string
}

// Only logs matching this chain AND contract (and within the verified cursor) feed the
// snapshot. Filtering on chain/contract prevents stale events from a previous deployment
// — if the store ever holds logs for another address/chain — from silently merging into a
// snapshot whose metadata claims the current address.
function getVerifiedLogs(data: IndexerStoreData, chainId: number, contractAddress: string): IndexedRawLog[] {
  const wantAddress = contractAddress.toLowerCase()
  return data.rawLogs
    .filter((log) =>
      log.blockNumber <= data.cursor.verifiedCursor &&
      log.chainId === chainId &&
      log.contractAddress.toLowerCase() === wantAddress,
    )
    .sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
      if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex
      return a.transactionHash.localeCompare(b.transactionHash)
    })
}

function getVerifiedBlockHash(logs: readonly IndexedRawLog[], verifiedBlockHash?: string): string {
  if (verifiedBlockHash) return verifiedBlockHash
  const lastLog = [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber
    return b.logIndex - a.logIndex
  })[0]
  return lastLog?.blockHash ?? ZERO_BLOCK_HASH
}

// The snapshot hash is a CONTENT ADDRESS: it must be byte-identical for identical
// verified chain state. It therefore hashes only the content-defining fields and
// deliberately excludes `generatedAt` (wall-clock, changes every build) and
// `reconciliation` (a post-hoc check that withReconciliation can swap in without
// altering snapshot identity).
interface SnapshotHashInput {
  schemaVersion: SnapshotMetadata['schemaVersion']
  chainId: number
  contractAddress: string
  deployBlock: number
  verifiedBlock: number
  verifiedBlockHash: string
  events: CrowdfundSnapshot['events']
  graph: CrowdfundSnapshot['graph']
}

function createSnapshotHash(input: SnapshotHashInput): string {
  const hash = createHash('sha256')
  hash.update(stableStringify(input))
  return `0x${hash.digest('hex')}`
}

function pendingReconciliation(): ReconciliationResult {
  return {
    status: 'pending',
    checkedBlock: null,
    provider: null,
    checkedAt: null,
    mismatches: [],
  }
}

export function buildSnapshot(input: BuildSnapshotInput): CrowdfundSnapshot {
  const logs = getVerifiedLogs(input.data, input.chainId, input.contractAddress)
  const events = parseCrowdfundEvents(logs.map((log) => ({
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    topics: [...log.topics],
    data: log.data,
  })))
  const graph = buildGraph(events)
  const metadataWithoutHash: Omit<SnapshotMetadata, 'snapshotHash'> = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    chainId: input.chainId,
    contractAddress: input.contractAddress.toLowerCase(),
    deployBlock: input.data.cursor.deployBlock,
    verifiedBlock: input.data.cursor.verifiedCursor,
    verifiedBlockHash: getVerifiedBlockHash(logs, input.verifiedBlockHash),
    generatedAt: new Date().toISOString(),
    reconciliation: input.reconciliation ?? pendingReconciliation(),
  }
  const snapshotHash = createSnapshotHash({
    schemaVersion: metadataWithoutHash.schemaVersion,
    chainId: metadataWithoutHash.chainId,
    contractAddress: metadataWithoutHash.contractAddress,
    deployBlock: metadataWithoutHash.deployBlock,
    verifiedBlock: metadataWithoutHash.verifiedBlock,
    verifiedBlockHash: metadataWithoutHash.verifiedBlockHash,
    events,
    graph,
  })

  return {
    metadata: {
      ...metadataWithoutHash,
      snapshotHash,
    },
    events,
    graph,
  }
}

// Returns a snapshot with its reconciliation result swapped in. Because reconciliation
// is excluded from the content hash, this does NOT rebuild or rehash the snapshot — it
// lets callers reconcile once and attach the result without a second buildSnapshot pass.
export function withReconciliation(
  snapshot: CrowdfundSnapshot,
  reconciliation: ReconciliationResult,
): CrowdfundSnapshot {
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      reconciliation,
    },
  }
}

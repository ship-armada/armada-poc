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

function getVerifiedLogs(data: IndexerStoreData): IndexedRawLog[] {
  return data.rawLogs
    .filter((log) => log.blockNumber <= data.cursor.verifiedCursor)
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

function createSnapshotHash(snapshot: Omit<CrowdfundSnapshot, 'metadata'> & { metadata: Omit<SnapshotMetadata, 'snapshotHash'> }): string {
  const hash = createHash('sha256')
  hash.update(stableStringify(snapshot))
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
  const logs = getVerifiedLogs(input.data)
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
    metadata: metadataWithoutHash,
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

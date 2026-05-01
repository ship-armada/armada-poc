// ABOUTME: Browser client helpers for loading crowdfund events from the indexer API.
// ABOUTME: Revives JSON snapshot event values into the bigint-rich event shape used by graph logic.

import type { CrowdfundEvent } from './events.js'

export interface IndexedSnapshotMetadata {
  schemaVersion: number
  chainId: number
  contractAddress: string
  deployBlock: number
  verifiedBlock: number
  verifiedBlockHash: string
  snapshotHash: string
  generatedAt: string
}

export interface IndexedEventsSnapshot {
  metadata: IndexedSnapshotMetadata
  events: CrowdfundEvent[]
}

export type IndexerHealthStatus =
  | 'healthy'
  | 'stale'
  | 'degraded'
  | 'unhealthy'
  | 'unavailable'

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
  gapRanges: readonly { fromBlock: number; toBlock: number }[]
  // Subset of gapRanges that the indexer's auto-repair loop has given up on.
  // When non-empty, an operator must run `crowdfund:indexer:cli -- repair`.
  // Optional in the type so older indexer responses (pre-field) still parse.
  gapsRequiringIntervention?: readonly { fromBlock: number; toBlock: number }[]
  lastError: string | null
  latestSnapshotHash: string | null
  latestStaticSnapshotUrl: string | null
}

interface RawIndexedSnapshot {
  metadata?: IndexedSnapshotMetadata
  events?: unknown[]
}

const BIGINT_FIELDS_BY_EVENT: Partial<Record<CrowdfundEvent['type'], readonly string[]>> = {
  Committed: ['amount'],
  Finalized: ['saleSize', 'allocatedArm', 'netProceeds'],
  Allocated: ['armTransferred', 'refundUsdc'],
  AllocatedHop: ['acceptedUsdc'],
  RefundClaimed: ['usdcAmount'],
  UnallocatedArmWithdrawn: ['amount'],
  Invited: ['nonce'],
  InviteNonceRevoked: ['nonce'],
}

function reviveArgs(type: CrowdfundEvent['type'], args: Record<string, unknown>): Record<string, unknown> {
  const bigintFields = new Set(BIGINT_FIELDS_BY_EVENT[type] ?? [])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (bigintFields.has(key) && typeof value === 'string') {
      out[key] = BigInt(value)
    } else {
      out[key] = value
    }
  }
  return out
}

export function reviveIndexedEvent(raw: unknown): CrowdfundEvent {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid indexed event')
  const event = raw as CrowdfundEvent
  return {
    type: event.type,
    blockNumber: Number(event.blockNumber),
    transactionHash: String(event.transactionHash),
    logIndex: Number(event.logIndex),
    args: reviveArgs(event.type, event.args as Record<string, unknown>),
  }
}

export async function fetchIndexedEventsSnapshot(baseUrl: string): Promise<IndexedEventsSnapshot> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const response = await fetch(`${trimmed}/snapshot`)
  if (!response.ok) {
    throw new Error(`Indexer snapshot request failed: ${response.status}`)
  }
  const raw = (await response.json()) as RawIndexedSnapshot
  if (!raw.metadata || !Array.isArray(raw.events)) {
    throw new Error('Indexer snapshot response is missing metadata or events')
  }
  return {
    metadata: raw.metadata,
    events: raw.events.map(reviveIndexedEvent),
  }
}

export async function fetchIndexerHealth(baseUrl: string): Promise<IndexerHealth> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const response = await fetch(`${trimmed}/health`)
  if (!response.ok) {
    throw new Error(`Indexer health request failed: ${response.status}`)
  }
  return (await response.json()) as IndexerHealth
}

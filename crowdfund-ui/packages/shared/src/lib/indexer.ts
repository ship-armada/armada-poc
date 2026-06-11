// ABOUTME: Browser client helpers for loading crowdfund events from the indexer API.
// ABOUTME: Revives JSON snapshot event values into the bigint-rich event shape used by graph logic.

import type { CrowdfundEvent } from './events.js'
import { VALID_EVENT_TYPES } from './events.js'

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

function assertEvent(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Invalid indexed event: ${detail}`)
}

/**
 * Revive a JSON snapshot event into the bigint-rich CrowdfundEvent shape, with
 * shape validation. Throws on a wrong `type`, a missing/bad core field, or a
 * required bigint arg that isn't a parseable integer string. Throwing here lets
 * the caller (useContractEvents) fall back to RPC instead of feeding malformed
 * data into graph math.
 */
export function reviveIndexedEvent(raw: unknown): CrowdfundEvent {
  assertEvent(raw && typeof raw === 'object', 'not an object')
  const event = raw as Record<string, unknown>

  const type = event.type
  assertEvent(
    typeof type === 'string' && VALID_EVENT_TYPES.has(type),
    `unknown type "${String(type)}"`,
  )

  assertEvent(
    typeof event.transactionHash === 'string' && event.transactionHash.length > 0,
    'missing transactionHash',
  )
  const blockNumber = Number(event.blockNumber)
  assertEvent(Number.isFinite(blockNumber), 'invalid blockNumber')
  const logIndex = Number(event.logIndex)
  assertEvent(Number.isFinite(logIndex), 'invalid logIndex')

  assertEvent(event.args !== null && typeof event.args === 'object', 'missing args')
  const args = event.args as Record<string, unknown>

  // Every required bigint arg for this event type must be a parseable integer
  // string — the snapshot serializes bigints as strings.
  const eventType = type as CrowdfundEvent['type']
  for (const field of BIGINT_FIELDS_BY_EVENT[eventType] ?? []) {
    const value = args[field]
    assertEvent(
      typeof value === 'string' && /^-?\d+$/.test(value),
      `field "${field}" must be a bigint string`,
    )
  }

  return {
    type: eventType,
    blockNumber,
    transactionHash: String(event.transactionHash),
    logIndex,
    args: reviveArgs(eventType, args),
  }
}

/** Abort indexer requests that hang so a stuck fetch can't freeze the UI. */
const INDEXER_FETCH_TIMEOUT_MS = 10_000

export async function fetchIndexedEventsSnapshot(baseUrl: string): Promise<IndexedEventsSnapshot> {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const response = await fetch(`${trimmed}/snapshot`, {
    signal: AbortSignal.timeout(INDEXER_FETCH_TIMEOUT_MS),
  })
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
  const response = await fetch(`${trimmed}/health`, {
    signal: AbortSignal.timeout(INDEXER_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Indexer health request failed: ${response.status}`)
  }
  return (await response.json()) as IndexerHealth
}

// ABOUTME: Health response construction for the crowdfund indexer API.
// ABOUTME: Maps cursor, gap, and snapshot metadata into deterministic frontend states.

import type { BlockRange, CursorState, IndexerHealth, IndexerHealthStatus } from '../types.js'

export interface BuildHealthInput {
  cursor: CursorState
  gapRanges: readonly BlockRange[]
  lastIngestedAt: string | null
  lastVerifiedAt: string | null
  lastReconciledAt: string | null
  lastError: string | null
  latestSnapshotHash: string | null
  latestStaticSnapshotUrl: string | null
  staleAfterBlocks?: number
}

function getHealthStatus(input: BuildHealthInput, lagBlocks: number): IndexerHealthStatus {
  if (input.lastError && input.gapRanges.length > 0) return 'unhealthy'
  if (input.gapRanges.length > 0) return 'degraded'
  if (lagBlocks > (input.staleAfterBlocks ?? 25)) return 'stale'
  return 'healthy'
}

export function buildHealth(input: BuildHealthInput): IndexerHealth {
  const lagBlocks = Math.max(0, input.cursor.confirmedHead - input.cursor.verifiedCursor)
  const status = getHealthStatus(input, lagBlocks)

  return {
    status,
    chainHead: input.cursor.chainHead,
    confirmedHead: input.cursor.confirmedHead,
    ingestedCursor: input.cursor.ingestedCursor,
    verifiedCursor: input.cursor.verifiedCursor,
    lagBlocks,
    lastIngestedAt: input.lastIngestedAt,
    lastVerifiedAt: input.lastVerifiedAt,
    lastReconciledAt: input.lastReconciledAt,
    hasGaps: input.gapRanges.length > 0,
    gapRanges: input.gapRanges,
    lastError: input.lastError,
    latestSnapshotHash: input.latestSnapshotHash,
    latestStaticSnapshotUrl: input.latestStaticSnapshotUrl,
  }
}

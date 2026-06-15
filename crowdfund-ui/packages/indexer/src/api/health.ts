// ABOUTME: Health response construction for the crowdfund indexer API.
// ABOUTME: Maps cursor, gap, and snapshot metadata into deterministic frontend states.

import type { BlockRange, CursorState, IndexerHealth, IndexerHealthStatus } from '../types.js'

export interface BuildHealthInput {
  cursor: CursorState
  gapRanges: readonly BlockRange[]
  // Subset of gapRanges that have hit the auto-repair attempt limit. When empty,
  // any gaps are considered transient (still being retried by the poll loop).
  gapsRequiringIntervention?: readonly BlockRange[]
  lastIngestedAt: string | null
  lastVerifiedAt: string | null
  lastReconciledAt: string | null
  lastError: string | null
  latestSnapshotHash: string | null
  latestStaticSnapshotUrl: string | null
  staleAfterBlocks?: number
  // Wall-clock budget (ms) after which a frozen indexer is considered stale even when
  // there are no gaps and block-lag reads as 0 (e.g. the RPC died and cursors stopped
  // advancing). Defaults to 5 minutes.
  staleAfterMs?: number
  // Injectable clock for deterministic tests; defaults to the current time.
  now?: () => Date
}

const DEFAULT_STALE_AFTER_MS = 300_000

function getHealthStatus(input: BuildHealthInput, lagBlocks: number, now: Date): IndexerHealthStatus {
  const exhausted = input.gapsRequiringIntervention?.length ?? 0
  // Surface unhealthy whenever auto-repair has given up on a gap, regardless of
  // whether a fresh transient error is currently pending.
  if (exhausted > 0) return 'unhealthy'
  if (input.lastError && input.gapRanges.length > 0) return 'unhealthy'
  if (input.gapRanges.length > 0) return 'degraded'

  // Wall-clock staleness: when verification has not advanced within the time budget,
  // the indexer is stuck (or dead) even if there are no recorded gaps and block-lag is
  // 0 because confirmedHead stopped advancing. A pending error during that window
  // escalates to unhealthy.
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  if (input.lastVerifiedAt !== null) {
    const ageMs = now.getTime() - new Date(input.lastVerifiedAt).getTime()
    if (ageMs > staleAfterMs) return input.lastError ? 'unhealthy' : 'stale'
  } else if (input.lastError) {
    // Nothing has ever verified and an error is pending → unhealthy.
    return 'unhealthy'
  }

  if (lagBlocks > (input.staleAfterBlocks ?? 25)) return 'stale'
  return 'healthy'
}

export function buildHealth(input: BuildHealthInput): IndexerHealth {
  const now = (input.now ?? (() => new Date()))()
  const lagBlocks = Math.max(0, input.cursor.confirmedHead - input.cursor.verifiedCursor)
  const status = getHealthStatus(input, lagBlocks, now)

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
    gapsRequiringIntervention: input.gapsRequiringIntervention ?? [],
    lastError: input.lastError,
    latestSnapshotHash: input.latestSnapshotHash,
    latestStaticSnapshotUrl: input.latestStaticSnapshotUrl,
  }
}

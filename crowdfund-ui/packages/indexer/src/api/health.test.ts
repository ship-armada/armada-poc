// ABOUTME: Unit tests for indexer health response classification.
// ABOUTME: Ensures frontend-facing health states are derived deterministically from cursor and gap data.

import { describe, expect, it } from 'vitest'
import { buildHealth } from './health.js'
import type { CursorState } from '../types.js'

const cursor: CursorState = {
  deployBlock: 100,
  confirmationDepth: 12,
  overlapWindow: 100,
  chainHead: 150,
  confirmedHead: 138,
  ingestedCursor: 138,
  verifiedCursor: 138,
}

describe('buildHealth', () => {
  it('reports healthy when verified cursor reaches confirmed head', () => {
    const health = buildHealth({
      cursor,
      gapRanges: [],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    })

    expect(health.status).toBe('healthy')
    expect(health.lagBlocks).toBe(0)
    expect(health.hasGaps).toBe(false)
  })

  it('reports stale when verified cursor lags beyond the SLA threshold', () => {
    const health = buildHealth({
      cursor: { ...cursor, verifiedCursor: 100 },
      gapRanges: [],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
      staleAfterBlocks: 10,
    })

    expect(health.status).toBe('stale')
    expect(health.lagBlocks).toBe(38)
  })

  it('reports degraded for known gaps without a current fatal error', () => {
    const health = buildHealth({
      cursor,
      gapRanges: [{ fromBlock: 120, toBlock: 125 }],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    })

    expect(health.status).toBe('degraded')
    expect(health.hasGaps).toBe(true)
  })

  it('reports unhealthy for gaps with a current error', () => {
    const health = buildHealth({
      cursor,
      gapRanges: [{ fromBlock: 120, toBlock: 125 }],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: 'RPC timeout',
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    })

    expect(health.status).toBe('unhealthy')
    expect(health.lastError).toBe('RPC timeout')
  })

  it('reports unhealthy when any gap has hit the auto-repair attempt limit', () => {
    const health = buildHealth({
      cursor,
      gapRanges: [{ fromBlock: 120, toBlock: 125 }],
      gapsRequiringIntervention: [{ fromBlock: 120, toBlock: 125 }],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    })

    expect(health.status).toBe('unhealthy')
    expect(health.gapsRequiringIntervention).toEqual([{ fromBlock: 120, toBlock: 125 }])
  })

  it('keeps degraded (transient) status when gaps exist but none have exhausted auto-repair', () => {
    const health = buildHealth({
      cursor,
      gapRanges: [{ fromBlock: 120, toBlock: 125 }],
      gapsRequiringIntervention: [],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    })

    expect(health.status).toBe('degraded')
    expect(health.gapsRequiringIntervention).toEqual([])
  })
})

// ABOUTME: Unit tests for event-derived graph reconciliation against contract reads.
// ABOUTME: Verifies matching snapshots pass and mismatched aggregate reads fail closed.

import { describe, expect, it } from 'vitest'
import { buildGraph } from '../../../shared/src/lib/graph.js'
import { deriveGraphAggregateStats, reconcileSnapshot } from './contract.js'
import type { CrowdfundEvent } from '../../../shared/src/lib/events.js'
import type { CrowdfundReadable } from './contract.js'

const participant = '0x1111111111111111111111111111111111111111'

function makeEvent(type: CrowdfundEvent['type'], args: Record<string, unknown>, blockNumber: number): CrowdfundEvent {
  return {
    type,
    blockNumber,
    transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    logIndex: 0,
    args,
  }
}

function makeContract(overrides: Partial<{
  participantCount: bigint
  totalCommitted: bigint
  cappedCommitted: bigint
}> = {}): CrowdfundReadable {
  const participantCount = overrides.participantCount ?? 1n
  const totalCommitted = overrides.totalCommitted ?? 1_000_000n
  const cappedCommitted = overrides.cappedCommitted ?? 1_000_000n
  return {
    getParticipantCount: async () => participantCount,
    getEstimatedCappedDemand: async () => [cappedCommitted, [cappedCommitted, 0n, 0n]],
    getHopStats: async (hop: number) => hop === 0
      ? [totalCommitted, cappedCommitted, 1n, 1n]
      : [0n, 0n, 0n, 0n],
  }
}

describe('contract reconciliation', () => {
  it('derives graph aggregate stats from events', () => {
    const graph = buildGraph([
      makeEvent('SeedAdded', { seed: participant }, 100),
      makeEvent('Committed', { participant, hop: 0, amount: 1_000_000n }, 101),
    ])

    expect(deriveGraphAggregateStats(graph)).toMatchObject({
      participantCount: 1,
      perHopTotalCommitted: [1_000_000n, 0n, 0n],
      perHopCappedCommitted: [1_000_000n, 0n, 0n],
      perHopUniqueCommitters: [1, 0, 0],
      perHopWhitelistCount: [1, 0, 0],
    })
  })

  it('passes when contract reads match event-derived aggregates', async () => {
    const graph = buildGraph([
      makeEvent('SeedAdded', { seed: participant }, 100),
      makeEvent('Committed', { participant, hop: 0, amount: 1_000_000n }, 101),
    ])

    const result = await reconcileSnapshot({
      graph,
      contract: makeContract(),
      checkedBlock: 110,
      providerName: 'primary',
    })

    expect(result.status).toBe('passed')
    expect(result.mismatches).toEqual([])
  })

  it('fails when contract reads disagree with event-derived aggregates', async () => {
    const graph = buildGraph([
      makeEvent('SeedAdded', { seed: participant }, 100),
      makeEvent('Committed', { participant, hop: 0, amount: 1_000_000n }, 101),
    ])

    const result = await reconcileSnapshot({
      graph,
      contract: makeContract({ totalCommitted: 2_000_000n }),
      checkedBlock: 110,
      providerName: 'primary',
    })

    expect(result.status).toBe('failed')
    expect(result.mismatches).toContain('hop0.totalCommitted: expected 1000000, got 2000000')
  })
})

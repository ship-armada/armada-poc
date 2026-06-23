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

  it('counts whitelisted addresses per hop, not stacked invites', () => {
    // Two seeds invite the same invitee into hop-1. On-chain this whitelists the
    // invitee once (hopStats[1].whitelistCount == 1) and only stacks its
    // invitesReceived. Reconciliation must count the distinct whitelisted node,
    // not the sum of invites, or it over-counts against the contract.
    const seedA = '0x1111111111111111111111111111111111111111'
    const seedB = '0x2222222222222222222222222222222222222222'
    const invitee = '0x3333333333333333333333333333333333333333'
    const graph = buildGraph([
      makeEvent('SeedAdded', { seed: seedA }, 100),
      makeEvent('SeedAdded', { seed: seedB }, 101),
      makeEvent('Invited', { inviter: seedA, invitee, hop: 1 }, 102),
      makeEvent('Invited', { inviter: seedB, invitee, hop: 1 }, 103),
    ])

    const stats = deriveGraphAggregateStats(graph)
    expect(stats.perHopWhitelistCount).toEqual([2, 1, 0])
    // seedA, seedB, invitee — three distinct (address, hop) participant nodes.
    expect(stats.participantCount).toBe(3)
  })

  it('counts a multi-hop address once per hop it is whitelisted in', () => {
    // An address whitelisted at both hop-1 and hop-2 is two participant nodes
    // on-chain (getParticipantCount returns participantNodes.length, which counts
    // (address, hop) pairs), so reconciliation must not de-duplicate it to one.
    const seed = '0x1111111111111111111111111111111111111111'
    const hop1Inviter = '0x2222222222222222222222222222222222222222'
    const multi = '0x3333333333333333333333333333333333333333'
    const graph = buildGraph([
      makeEvent('SeedAdded', { seed }, 100),
      makeEvent('Invited', { inviter: seed, invitee: hop1Inviter, hop: 1 }, 101),
      makeEvent('Invited', { inviter: seed, invitee: multi, hop: 1 }, 102),
      makeEvent('Invited', { inviter: hop1Inviter, invitee: multi, hop: 2 }, 103),
    ])

    const stats = deriveGraphAggregateStats(graph)
    // seed@0, hop1Inviter@1, multi@1, multi@2 = 4 participant nodes.
    expect(stats.participantCount).toBe(4)
    expect(stats.perHopWhitelistCount).toEqual([1, 2, 1])
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

  it('pins every contract read to the checked block', async () => {
    const graph = buildGraph([
      makeEvent('SeedAdded', { seed: participant }, 100),
      makeEvent('Committed', { participant, hop: 0, amount: 1_000_000n }, 101),
    ])
    const seenBlockTags: Array<number | undefined> = []
    const contract: CrowdfundReadable = {
      getParticipantCount: async (overrides) => {
        seenBlockTags.push(overrides?.blockTag)
        return 1n
      },
      getEstimatedCappedDemand: async (overrides) => {
        seenBlockTags.push(overrides?.blockTag)
        return [1_000_000n, [1_000_000n, 0n, 0n]]
      },
      getHopStats: async (hop, overrides) => {
        seenBlockTags.push(overrides?.blockTag)
        return hop === 0 ? [1_000_000n, 1_000_000n, 1n, 1n] : [0n, 0n, 0n, 0n]
      },
    }

    const result = await reconcileSnapshot({ graph, contract, checkedBlock: 110, providerName: 'primary' })

    expect(result.status).toBe('passed')
    expect(seenBlockTags).toHaveLength(5)
    expect(seenBlockTags.every((tag) => tag === 110)).toBe(true)
  })

  it('returns pending (not failed) when historical state is unavailable', async () => {
    const graph = buildGraph([makeEvent('SeedAdded', { seed: participant }, 100)])
    const contract: CrowdfundReadable = {
      getParticipantCount: async () => {
        throw new Error('missing trie node 0xabc (path ) state 0xdef is not available')
      },
      getEstimatedCappedDemand: async () => [0n, [0n, 0n, 0n]],
      getHopStats: async () => [0n, 0n, 0n, 0n],
    }

    const result = await reconcileSnapshot({ graph, contract, checkedBlock: 110, providerName: 'primary' })

    expect(result.status).toBe('pending')
    expect(result.checkedBlock).toBe(110)
    expect(result.mismatches.join(' ')).toContain('historical state')
  })

  it('rethrows non-state read errors', async () => {
    const graph = buildGraph([makeEvent('SeedAdded', { seed: participant }, 100)])
    const contract: CrowdfundReadable = {
      getParticipantCount: async () => {
        throw new Error('connection refused')
      },
      getEstimatedCappedDemand: async () => [0n, [0n, 0n, 0n]],
      getHopStats: async () => [0n, 0n, 0n, 0n],
    }

    await expect(
      reconcileSnapshot({ graph, contract, checkedBlock: 110, providerName: 'primary' }),
    ).rejects.toThrow('connection refused')
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

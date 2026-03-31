// ABOUTME: Unit tests for graph construction from crowdfund events.
// ABOUTME: Tests node/edge topology, summaries, and display inviter logic.

import { describe, it, expect } from 'vitest'
import { buildGraph, mergeEvents } from './graph.js'
import type { CrowdfundEvent } from './events.js'

const ADDR = {
  seed1: '0x' + '01'.repeat(20),
  seed2: '0x' + '02'.repeat(20),
  hop1a: '0x' + '0a'.repeat(20),
  hop1b: '0x' + '0b'.repeat(20),
  hop2a: '0x' + 'a0'.repeat(20),
  delegate: '0x' + 'dd'.repeat(20),
}

function mkEvent(
  type: CrowdfundEvent['type'],
  args: Record<string, unknown>,
  blockNumber = 1,
): CrowdfundEvent {
  return {
    type,
    blockNumber,
    transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    logIndex: 0,
    args,
  }
}

describe('buildGraph', () => {
  it('creates seed nodes from SeedAdded events', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 2),
    ]
    const graph = buildGraph(events)

    expect(graph.nodes.size).toBe(2)
    const node = graph.nodes.get(`${ADDR.seed1}-0`)!
    expect(node.hop).toBe(0)
    expect(node.invitesReceived).toBe(1)
    expect(node.invitedBy).toEqual(['armada'])

    expect(graph.edges).toHaveLength(2)
    expect(graph.edges[0].fromAddress).toBe('armada')
    expect(graph.edges[0].toAddress).toBe(ADDR.seed1)
  })

  it('creates invite edges and updates inviter counts', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Invited', { inviter: ADDR.seed1, invitee: ADDR.hop1a, hop: 1n, nonce: 1n }, 2),
    ]
    const graph = buildGraph(events)

    // Invitee node at hop 1
    const inviteeNode = graph.nodes.get(`${ADDR.hop1a}-1`)!
    expect(inviteeNode.invitesReceived).toBe(1)
    expect(inviteeNode.invitedBy).toEqual([ADDR.seed1])

    // Inviter's used/available counts updated
    const inviterNode = graph.nodes.get(`${ADDR.seed1}-0`)!
    expect(inviterNode.invitesUsed).toBe(1)
    expect(inviterNode.invitesAvailable).toBe(2) // maxInvites=3 for hop-0, minus 1

    // Edge from inviter → invitee
    expect(graph.edges).toHaveLength(2) // ROOT→seed + seed→hop1a
    const inviteEdge = graph.edges[1]
    expect(inviteEdge.fromAddress).toBe(ADDR.seed1)
    expect(inviteEdge.fromHop).toBe(0)
    expect(inviteEdge.toAddress).toBe(ADDR.hop1a)
    expect(inviteEdge.toHop).toBe(1)
  })

  it('tracks committed amounts with cap enforcement', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 10_000n * 10n ** 6n }, 2),
    ]
    const graph = buildGraph(events)
    const node = graph.nodes.get(`${ADDR.seed1}-0`)!

    // rawDeposited is the full amount
    expect(node.rawDeposited).toBe(10_000n * 10n ** 6n)
    // committed is capped at invitesReceived × cap (1 × 15000 USDC = 15000 USDC)
    // 10000 < 15000, so committed = rawDeposited
    expect(node.committed).toBe(10_000n * 10n ** 6n)
  })

  it('caps committed when rawDeposited exceeds cap', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 20_000n * 10n ** 6n }, 2),
    ]
    const graph = buildGraph(events)
    const node = graph.nodes.get(`${ADDR.seed1}-0`)!

    expect(node.rawDeposited).toBe(20_000n * 10n ** 6n)
    // Capped at 1 invite × 15000 USDC cap
    expect(node.committed).toBe(15_000n * 10n ** 6n)
  })

  it('builds address summaries with per-hop breakdown', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 5_000n * 10n ** 6n }, 2),
      // seed1 also invited at hop-1 by seed2
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 3),
      mkEvent('Invited', { inviter: ADDR.seed2, invitee: ADDR.seed1, hop: 1n, nonce: 1n }, 4),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 1n, amount: 2_000n * 10n ** 6n }, 5),
    ]
    const graph = buildGraph(events)
    const summary = graph.summaries.get(ADDR.seed1)!

    expect(summary.hops).toEqual([0, 1])
    expect(summary.totalCommitted).toBe(7_000n * 10n ** 6n)
    expect(summary.perHop.get(0)).toBe(5_000n * 10n ** 6n)
    expect(summary.perHop.get(1)).toBe(2_000n * 10n ** 6n)
  })

  it('display inviter is "armada" for hop-0 only participants', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
    ]
    const graph = buildGraph(events)
    const summary = graph.summaries.get(ADDR.seed1)!
    expect(summary.displayInviter).toBe('armada')
  })

  it('display inviter is the single inviter for single-hop non-seed', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Invited', { inviter: ADDR.seed1, invitee: ADDR.hop1a, hop: 1n, nonce: 1n }, 2),
    ]
    const graph = buildGraph(events)
    const summary = graph.summaries.get(ADDR.hop1a)!
    expect(summary.displayInviter).toBe(ADDR.seed1)
  })

  it('display inviter uses lowest-hop inviter when multiple inviters', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 2),
      mkEvent('Invited', { inviter: ADDR.seed1, invitee: ADDR.hop1a, hop: 1n, nonce: 1n }, 3),
      mkEvent('Invited', { inviter: ADDR.seed2, invitee: ADDR.hop1a, hop: 1n, nonce: 2n }, 4),
    ]
    const graph = buildGraph(events)
    const summary = graph.summaries.get(ADDR.hop1a)!
    // Both at hop-1, first inviter should be displayed
    expect(summary.displayInviter).toBe(ADDR.seed1)
  })

  it('processes AllocatedHop events', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 5_000n * 10n ** 6n }, 2),
      mkEvent('AllocatedHop', { participant: ADDR.seed1, hop: 0n, acceptedUsdc: 4_000n * 10n ** 6n }, 3),
    ]
    const graph = buildGraph(events)
    const node = graph.nodes.get(`${ADDR.seed1}-0`)!
    expect(node.acceptedUsdc).toBe(4_000n * 10n ** 6n)
    expect(node.allocatedArm).toBe(4_000n * 10n ** 6n * 10n ** 12n)

    const summary = graph.summaries.get(ADDR.seed1)!
    expect(summary.allocatedPerHop.get(0)).toBe(4_000n * 10n ** 6n)
  })

  it('processes Allocated events at summary level', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 5_000n * 10n ** 6n }, 2),
      mkEvent('Allocated', {
        participant: ADDR.seed1,
        armTransferred: 4_000n * 10n ** 18n,
        refundUsdc: 1_000n * 10n ** 6n,
        delegate: ADDR.delegate,
      }, 3),
    ]
    const graph = buildGraph(events)
    const summary = graph.summaries.get(ADDR.seed1)!
    expect(summary.allocatedArm).toBe(4_000n * 10n ** 18n)
    expect(summary.refundUsdc).toBe(1_000n * 10n ** 6n)
    expect(summary.delegate).toBe(ADDR.delegate)
    expect(summary.armClaimed).toBe(true)
  })

  it('processes RefundClaimed events', () => {
    const events = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 5_000n * 10n ** 6n }, 2),
      mkEvent('RefundClaimed', { participant: ADDR.seed1, usdcAmount: 5_000n * 10n ** 6n }, 3),
    ]
    const graph = buildGraph(events)
    const summary = graph.summaries.get(ADDR.seed1)!
    expect(summary.refundClaimed).toBe(true)
    expect(summary.refundUsdc).toBe(5_000n * 10n ** 6n)
  })

  it('handles empty event list', () => {
    const graph = buildGraph([])
    expect(graph.nodes.size).toBe(0)
    expect(graph.edges).toHaveLength(0)
    expect(graph.summaries.size).toBe(0)
  })
})

describe('mergeEvents', () => {
  it('adds new events to an existing graph', () => {
    const initial = buildGraph([
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
    ])
    expect(initial.nodes.size).toBe(1)

    const merged = mergeEvents(initial, [
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 2),
    ])
    expect(merged.nodes.size).toBe(2)
    // Original graph unchanged
    expect(initial.nodes.size).toBe(1)
  })

  it('updates existing nodes with new commits', () => {
    const initial = buildGraph([
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 1_000n * 10n ** 6n }, 2),
    ])

    const merged = mergeEvents(initial, [
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 2_000n * 10n ** 6n }, 3),
    ])

    const node = merged.nodes.get(`${ADDR.seed1}-0`)!
    expect(node.rawDeposited).toBe(3_000n * 10n ** 6n)
    expect(node.committed).toBe(3_000n * 10n ** 6n)
  })

  it('preserves summary-level data from old events after merge', () => {
    const oldEvents = [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 5_000n * 10n ** 6n }, 2),
      mkEvent('Allocated', {
        participant: ADDR.seed1,
        armTransferred: 4_000n * 10n ** 18n,
        refundUsdc: 1_000n * 10n ** 6n,
        delegate: ADDR.delegate,
      }, 3),
    ]
    const initial = buildGraph(oldEvents)

    // Verify initial state
    expect(initial.summaries.get(ADDR.seed1)!.armClaimed).toBe(true)
    expect(initial.summaries.get(ADDR.seed1)!.delegate).toBe(ADDR.delegate)

    // Merge with a new, unrelated event
    const merged = mergeEvents(initial, [
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 4),
    ])

    // Summary-level data from old Allocated event must be preserved
    const summary = merged.summaries.get(ADDR.seed1)!
    expect(summary.armClaimed).toBe(true)
    expect(summary.allocatedArm).toBe(4_000n * 10n ** 18n)
    expect(summary.refundUsdc).toBe(1_000n * 10n ** 6n)
    expect(summary.delegate).toBe(ADDR.delegate)
  })
})

describe('full lifecycle', () => {
  it('handles seeds → invites → commits → finalize → claims', () => {
    const events: CrowdfundEvent[] = [
      // Seeds
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 1),
      // ARM loaded (no graph effect)
      mkEvent('ArmLoaded', {}, 2),
      // Invites
      mkEvent('Invited', { inviter: ADDR.seed1, invitee: ADDR.hop1a, hop: 1n, nonce: 1n }, 3),
      mkEvent('Invited', { inviter: ADDR.seed1, invitee: ADDR.hop1b, hop: 1n, nonce: 2n }, 4),
      mkEvent('Invited', { inviter: ADDR.hop1a, invitee: ADDR.hop2a, hop: 2n, nonce: 3n }, 5),
      // Commits
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 10_000n * 10n ** 6n }, 6),
      mkEvent('Committed', { participant: ADDR.seed2, hop: 0n, amount: 8_000n * 10n ** 6n }, 6),
      mkEvent('Committed', { participant: ADDR.hop1a, hop: 1n, amount: 3_000n * 10n ** 6n }, 7),
      mkEvent('Committed', { participant: ADDR.hop1b, hop: 1n, amount: 2_000n * 10n ** 6n }, 7),
      mkEvent('Committed', { participant: ADDR.hop2a, hop: 2n, amount: 500n * 10n ** 6n }, 8),
      // Finalize (no graph topology effect)
      mkEvent('Finalized', {
        saleSize: 1_200_000n * 10n ** 6n,
        allocatedArm: 1_200_000n * 10n ** 18n,
        netProceeds: 1_100_000n * 10n ** 6n,
        refundMode: false,
      }, 9),
      // Per-hop allocations
      mkEvent('AllocatedHop', { participant: ADDR.seed1, hop: 0n, acceptedUsdc: 9_000n * 10n ** 6n }, 10),
      mkEvent('AllocatedHop', { participant: ADDR.hop1a, hop: 1n, acceptedUsdc: 2_500n * 10n ** 6n }, 10),
      // Claims
      mkEvent('Allocated', {
        participant: ADDR.seed1,
        armTransferred: 9_000n * 10n ** 18n,
        refundUsdc: 1_000n * 10n ** 6n,
        delegate: ADDR.delegate,
      }, 11),
    ]

    const graph = buildGraph(events)

    // Verify topology
    expect(graph.nodes.size).toBe(5) // 2 seeds + 2 hop1 + 1 hop2
    expect(graph.edges).toHaveLength(5) // 2 ROOT→seed + 2 seed→hop1 + 1 hop1→hop2
    expect(graph.summaries.size).toBe(5)

    // Verify seed1 summary
    const s1 = graph.summaries.get(ADDR.seed1)!
    expect(s1.totalCommitted).toBe(10_000n * 10n ** 6n)
    expect(s1.allocatedArm).toBe(9_000n * 10n ** 18n)
    expect(s1.refundUsdc).toBe(1_000n * 10n ** 6n)
    expect(s1.armClaimed).toBe(true)
    expect(s1.delegate).toBe(ADDR.delegate)

    // Verify hop2a
    const h2a = graph.summaries.get(ADDR.hop2a)!
    expect(h2a.totalCommitted).toBe(500n * 10n ** 6n)
    expect(h2a.displayInviter).toBe(ADDR.hop1a)
  })
})

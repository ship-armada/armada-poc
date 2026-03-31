// ABOUTME: Tests for the useGraphState derived atom.
// ABOUTME: Verifies that the graph atom recomputes correctly when events change.

import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import { crowdfundEventsAtom } from './useContractEvents.js'
import { crowdfundGraphAtom } from './useGraphState.js'
import type { CrowdfundEvent } from '../lib/events.js'

const ADDR = {
  seed1: '0x' + '01'.repeat(20),
  seed2: '0x' + '02'.repeat(20),
  hop1a: '0x' + '0a'.repeat(20),
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

describe('crowdfundGraphAtom', () => {
  it('produces an empty graph when events atom is empty', () => {
    const store = createStore()
    store.set(crowdfundEventsAtom, [])
    const graph = store.get(crowdfundGraphAtom)

    expect(graph.nodes.size).toBe(0)
    expect(graph.edges).toHaveLength(0)
    expect(graph.summaries.size).toBe(0)
  })

  it('derives graph from events atom', () => {
    const store = createStore()
    store.set(crowdfundEventsAtom, [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('SeedAdded', { seed: ADDR.seed2 }, 2),
    ])
    const graph = store.get(crowdfundGraphAtom)

    expect(graph.nodes.size).toBe(2)
    expect(graph.edges).toHaveLength(2)
    expect(graph.summaries.size).toBe(2)
    expect(graph.summaries.get(ADDR.seed1)!.displayInviter).toBe('armada')
  })

  it('recomputes when events atom is updated', () => {
    const store = createStore()

    // Initial state: one seed
    store.set(crowdfundEventsAtom, [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
    ])
    let graph = store.get(crowdfundGraphAtom)
    expect(graph.nodes.size).toBe(1)

    // Add more events
    store.set(crowdfundEventsAtom, [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Invited', { inviter: ADDR.seed1, invitee: ADDR.hop1a, hop: 1n, nonce: 1n }, 2),
      mkEvent('Committed', { participant: ADDR.hop1a, hop: 1n, amount: 2_000n * 10n ** 6n }, 3),
    ])
    graph = store.get(crowdfundGraphAtom)

    expect(graph.nodes.size).toBe(2)
    expect(graph.edges).toHaveLength(2) // ROOT→seed1 + seed1→hop1a

    const hop1Node = graph.nodes.get(`${ADDR.hop1a}-1`)!
    expect(hop1Node.committed).toBe(2_000n * 10n ** 6n)

    const summary = graph.summaries.get(ADDR.hop1a)!
    expect(summary.totalCommitted).toBe(2_000n * 10n ** 6n)
    expect(summary.displayInviter).toBe(ADDR.seed1)
  })

  it('includes allocation data from Allocated events', () => {
    const store = createStore()
    const delegate = '0x' + 'dd'.repeat(20)

    store.set(crowdfundEventsAtom, [
      mkEvent('SeedAdded', { seed: ADDR.seed1 }, 1),
      mkEvent('Committed', { participant: ADDR.seed1, hop: 0n, amount: 5_000n * 10n ** 6n }, 2),
      mkEvent('Allocated', {
        participant: ADDR.seed1,
        armTransferred: 5_000n * 10n ** 18n,
        refundUsdc: 0n,
        delegate,
      }, 3),
    ])

    const graph = store.get(crowdfundGraphAtom)
    const summary = graph.summaries.get(ADDR.seed1)!
    expect(summary.allocatedArm).toBe(5_000n * 10n ** 18n)
    expect(summary.armClaimed).toBe(true)
    expect(summary.delegate).toBe(delegate)
  })
})

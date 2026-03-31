// ABOUTME: Tests for useEligibility hook — position derivation from graph nodes.
// ABOUTME: Covers eligible, multi-hop, no invites, and cap calculation scenarios.

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEligibility } from './useEligibility'
import type { GraphNode } from '@armada/crowdfund-shared'

function makeNode(overrides: Partial<GraphNode> & { address: string; hop: number }): GraphNode {
  return {
    invitesReceived: 0,
    committed: 0n,
    rawDeposited: 0n,
    invitedBy: [],
    invitesUsed: 0,
    invitesAvailable: 0,
    allocatedArm: null,
    acceptedUsdc: null,
    ...overrides,
  }
}

describe('useEligibility', () => {
  it('returns not eligible when address is null', () => {
    const { result } = renderHook(() => useEligibility(null, new Map()))
    expect(result.current.eligible).toBe(false)
    expect(result.current.positions).toHaveLength(0)
    expect(result.current.totalCommitted).toBe(0n)
  })

  it('returns not eligible when address has no nodes', () => {
    const nodes = new Map<string, GraphNode>()
    const { result } = renderHook(() => useEligibility('0xabc', nodes))
    expect(result.current.eligible).toBe(false)
  })

  it('returns not eligible when node has zero invitesReceived', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('0xabc-0', makeNode({ address: '0xabc', hop: 0, invitesReceived: 0 }))
    const { result } = renderHook(() => useEligibility('0xabc', nodes))
    expect(result.current.eligible).toBe(false)
  })

  it('returns eligible with single hop-0 position', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('0xabc-0', makeNode({
      address: '0xabc',
      hop: 0,
      invitesReceived: 1,
      committed: 5_000n * 10n ** 6n,
      invitedBy: ['armada'],
    }))
    const { result } = renderHook(() => useEligibility('0xabc', nodes))
    expect(result.current.eligible).toBe(true)
    expect(result.current.positions).toHaveLength(1)
    const pos = result.current.positions[0]
    expect(pos.hop).toBe(0)
    expect(pos.invitesReceived).toBe(1)
    expect(pos.committed).toBe(5_000n * 10n ** 6n)
    // Hop-0 cap is 15,000 USDC per invite
    expect(pos.effectiveCap).toBe(15_000n * 10n ** 6n)
    expect(pos.remaining).toBe(10_000n * 10n ** 6n)
  })

  it('returns multi-hop positions', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('0xabc-0', makeNode({
      address: '0xabc',
      hop: 0,
      invitesReceived: 1,
      committed: 0n,
    }))
    nodes.set('0xabc-1', makeNode({
      address: '0xabc',
      hop: 1,
      invitesReceived: 2,
      committed: 3_000n * 10n ** 6n,
    }))
    const { result } = renderHook(() => useEligibility('0xabc', nodes))
    expect(result.current.eligible).toBe(true)
    expect(result.current.positions).toHaveLength(2)
    expect(result.current.totalCommitted).toBe(3_000n * 10n ** 6n)

    // Hop-1 cap is 4,000 USDC per invite, 2 invites = 8,000
    const hop1Pos = result.current.positions[1]
    expect(hop1Pos.effectiveCap).toBe(8_000n * 10n ** 6n)
    expect(hop1Pos.remaining).toBe(5_000n * 10n ** 6n)
  })

  it('computes remaining as 0 when fully committed', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('0xabc-2', makeNode({
      address: '0xabc',
      hop: 2,
      invitesReceived: 1,
      committed: 1_000n * 10n ** 6n,
    }))
    const { result } = renderHook(() => useEligibility('0xabc', nodes))
    expect(result.current.positions[0].remaining).toBe(0n)
  })

  it('handles case-insensitive address lookup', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('0xabc-0', makeNode({
      address: '0xABC',
      hop: 0,
      invitesReceived: 1,
      committed: 0n,
    }))
    // Address passed in uppercase, key is lowercase
    const { result } = renderHook(() => useEligibility('0xABC', nodes))
    expect(result.current.eligible).toBe(true)
  })

  it('tracks invitesUsed and invitesAvailable', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('0xabc-0', makeNode({
      address: '0xabc',
      hop: 0,
      invitesReceived: 1,
      committed: 0n,
      invitesUsed: 2,
      invitesAvailable: 1,
    }))
    const { result } = renderHook(() => useEligibility('0xabc', nodes))
    expect(result.current.positions[0].invitesUsed).toBe(2)
    expect(result.current.positions[0].invitesAvailable).toBe(1)
  })
})

// ABOUTME: Tests for treeLayout.ts — graph-to-tree transformation.
// ABOUTME: Covers single-hop, multi-hop, self-invite, dedup, and search filtering.

import { describe, it, expect } from 'vitest'
import { graphToTree, filterTree, type TreeNode } from './treeLayout.js'
import { buildGraph } from './graph.js'
import type { CrowdfundEvent } from './events.js'

/** Helper to create typed events with minimal boilerplate */
function seedEvent(seed: string, blockNumber = 1): CrowdfundEvent {
  return {
    type: 'SeedAdded',
    args: { seed },
    blockNumber,
    logIndex: 0,
    transactionHash: '0xaaa',
  }
}

function inviteEvent(inviter: string, invitee: string, hop: number, blockNumber = 2): CrowdfundEvent {
  return {
    type: 'Invited',
    args: { inviter, invitee, hop: BigInt(hop), nonce: 0n },
    blockNumber,
    logIndex: 0,
    transactionHash: '0xbbb',
  }
}

function commitEvent(participant: string, hop: number, amount: bigint, blockNumber = 3): CrowdfundEvent {
  return {
    type: 'Committed',
    args: { participant, hop: BigInt(hop), amount },
    blockNumber,
    logIndex: 0,
    transactionHash: '0xccc',
  }
}

function allocatedHopEvent(participant: string, hop: number, acceptedUsdc: bigint, blockNumber = 4): CrowdfundEvent {
  return {
    type: 'AllocatedHop',
    args: { participant, hop: BigInt(hop), acceptedUsdc },
    blockNumber,
    logIndex: 0,
    transactionHash: '0xddd',
  }
}

function launchTeamInviteEvent(invitee: string, hop: number, blockNumber = 2): CrowdfundEvent {
  return {
    type: 'LaunchTeamInvited',
    args: { invitee, hop: BigInt(hop) },
    blockNumber,
    logIndex: 0,
    transactionHash: '0xbbb',
  }
}

const noResolve = () => null

describe('graphToTree', () => {
  it('produces a root node for an empty graph', () => {
    const graph = buildGraph([])
    const tree = graphToTree(graph, noResolve)

    expect(tree.id).toBe('armada')
    expect(tree.hop).toBe(-1)
    expect(tree.children).toHaveLength(0)
  })

  it('places seeds as children of root at hop-0', () => {
    const events = [
      seedEvent('0xAlice'),
      seedEvent('0xBob'),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    expect(tree.children).toHaveLength(2)
    for (const child of tree.children) {
      expect(child.hop).toBe(0)
    }
    const addrs = tree.children.map((c) => c.address)
    expect(addrs).toContain('0xalice')
    expect(addrs).toContain('0xbob')
  })

  it('builds a two-level tree: root → seed → invitee', () => {
    const events = [
      seedEvent('0xAlice'),
      inviteEvent('0xAlice', '0xBob', 1),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    expect(tree.children).toHaveLength(1) // Alice
    const alice = tree.children[0]
    expect(alice.address).toBe('0xalice')
    expect(alice.children).toHaveLength(1) // Bob
    expect(alice.children[0].address).toBe('0xbob')
    expect(alice.children[0].hop).toBe(1)
  })

  it('merges multi-hop addresses into a single node', () => {
    // Alice is seed AND gets invited at hop-1 by Bob
    const events = [
      seedEvent('0xAlice'),
      seedEvent('0xBob'),
      inviteEvent('0xBob', '0xAlice', 1),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    // Alice should appear as a single node (under root, at her lowest hop = 0)
    const aliceNodes = findAll(tree, (n) => n.address === '0xalice')
    expect(aliceNodes).toHaveLength(1)
    expect(aliceNodes[0].isMultiHop).toBe(true)
    expect(aliceNodes[0].hops).toContain(0)
    expect(aliceNodes[0].hops).toContain(1)
    expect(aliceNodes[0].hop).toBe(0)
  })

  it('handles self-invite edges without creating duplicate nodes', () => {
    // Alice is seed, then invites herself at hop-1
    const events = [
      seedEvent('0xAlice'),
      inviteEvent('0xAlice', '0xAlice', 1),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    const aliceNodes = findAll(tree, (n) => n.address === '0xalice')
    expect(aliceNodes).toHaveLength(1)
    expect(aliceNodes[0].isMultiHop).toBe(true)
  })

  it('tracks committed amounts from graph summaries', () => {
    const events = [
      seedEvent('0xAlice'),
      commitEvent('0xAlice', 0, 5_000n * 10n ** 6n),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    const alice = tree.children[0]
    expect(alice.committed).toBe(5_000n * 10n ** 6n)
  })

  it('uses ENS names for labels when available', () => {
    const events = [seedEvent('0xAlice')]
    const graph = buildGraph(events)
    const resolve = (addr: string) => addr === '0xalice' ? 'alice.eth' : null
    const tree = graphToTree(graph, resolve)

    expect(tree.children[0].label).toBe('alice.eth')
  })

  it('sorts children by committed amount descending', () => {
    const events = [
      seedEvent('0xAlice'),
      seedEvent('0xBob'),
      commitEvent('0xAlice', 0, 1_000n * 10n ** 6n),
      commitEvent('0xBob', 0, 5_000n * 10n ** 6n),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    expect(tree.children[0].address).toBe('0xbob')
    expect(tree.children[1].address).toBe('0xalice')
  })

  it('deduplicates: address invited by multiple parents goes under lowest-hop parent', () => {
    const events = [
      seedEvent('0xAlice'),
      seedEvent('0xBob'),
      inviteEvent('0xAlice', '0xCharlie', 1),
      inviteEvent('0xBob', '0xCharlie', 1),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    // Charlie should appear once, under whichever parent was at the lowest hop (both are hop-0)
    const charlieNodes = findAll(tree, (n) => n.address === '0xcharlie')
    expect(charlieNodes).toHaveLength(1)
  })

  it('places launch team invitees under root', () => {
    // Launch team invites 0xDave at hop-1 via LaunchTeamInvited event
    const events = [
      seedEvent('0xAlice'),
      launchTeamInviteEvent('0xDave', 1),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    // Dave should appear in the tree as a direct child of root
    const daveNodes = findAll(tree, (n) => n.address === '0xdave')
    expect(daveNodes).toHaveLength(1)
    expect(daveNodes[0].hop).toBe(1)

    const rootChildAddrs = tree.children.map((c) => c.address)
    expect(rootChildAddrs).toContain('0xdave')
  })

  it('launch team invitee subtree is placed correctly', () => {
    // Launch team invites hop-1, who then invites hop-2 via peer invite
    const events = [
      launchTeamInviteEvent('0xHop1', 1),
      inviteEvent('0xHop1', '0xHop2', 2),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    // Hop1 should be under root, Hop2 should be under Hop1
    const hop1Nodes = findAll(tree, (n) => n.address === '0xhop1')
    expect(hop1Nodes).toHaveLength(1)
    expect(hop1Nodes[0].children).toHaveLength(1)
    expect(hop1Nodes[0].children[0].address).toBe('0xhop2')
  })

  it('includes allocation data when available', () => {
    const events = [
      seedEvent('0xAlice'),
      commitEvent('0xAlice', 0, 10_000n * 10n ** 6n),
      allocatedHopEvent('0xAlice', 0, 8_000n * 10n ** 6n),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    const alice = tree.children[0]
    expect(alice.allocatedArm).not.toBeNull()
  })
})

describe('filterTree', () => {
  it('returns empty set when no nodes match', () => {
    const events = [seedEvent('0xAlice')]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    const matched = filterTree(tree, 'zzz_nothing_matches')
    expect(matched.size).toBe(0)
  })

  it('matches by address substring', () => {
    const events = [
      seedEvent('0xAlice'),
      seedEvent('0xBob'),
    ]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    const matched = filterTree(tree, 'alice')
    expect(matched.has('0xalice')).toBe(true)
    expect(matched.has('0xbob')).toBe(false)
    // Root is included when any child matches
    expect(matched.has('armada')).toBe(true)
  })

  it('matches by label (ENS name)', () => {
    const events = [seedEvent('0xAbCdEf1234567890')]
    const graph = buildGraph(events)
    const resolve = (addr: string) =>
      addr === '0xabcdef1234567890' ? 'alice.eth' : null
    const tree = graphToTree(graph, resolve)

    const matched = filterTree(tree, 'alice.eth')
    expect(matched.has('0xabcdef1234567890')).toBe(true)
  })

  it('is case-insensitive', () => {
    const events = [seedEvent('0xAlice')]
    const graph = buildGraph(events)
    const tree = graphToTree(graph, noResolve)

    const matched = filterTree(tree, 'ALICE')
    expect(matched.has('0xalice')).toBe(true)
  })
})

/** Find all nodes in the tree matching a predicate */
function findAll(node: TreeNode, predicate: (n: TreeNode) => boolean): TreeNode[] {
  const result: TreeNode[] = []
  function walk(n: TreeNode) {
    if (predicate(n)) result.push(n)
    for (const child of n.children) walk(child)
  }
  walk(node)
  return result
}

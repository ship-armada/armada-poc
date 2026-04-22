// ABOUTME: Synthetic CrowdfundGraph generator for spike A/B testing and stress demos.
// ABOUTME: Dev-only. Produces reproducible graphs at configurable scale — used via ?mock=stressN.

import type { CrowdfundGraph, GraphNode, GraphEdge, AddressSummary } from './graph.js'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fakeAddress(rand: () => number): string {
  const hex = '0123456789abcdef'
  let out = '0x'
  for (let i = 0; i < 40; i++) out += hex[Math.floor(rand() * 16)]
  return out
}

export interface MockGraphOptions {
  /** Fraction of hop-1 addresses that also appear at hop-2 (multi-hop rendering). Default 0.05. */
  multiHopRatio?: number
  /** RNG seed for reproducibility. Default 42. */
  seed?: number
}

/**
 * Build a synthetic CrowdfundGraph of roughly `targetNodeCount` addresses.
 *
 * Structure (approximate):
 *   - hop-0 seeds ≈ 2% of target
 *   - each hop-0 invites ≈ 8 hop-1
 *   - each hop-1 invites ≈ targetRemaining / hop-1-count
 *   - ~`multiHopRatio` of hop-1 also appear at hop-2
 */
export function generateMockGraph(
  targetNodeCount: number,
  opts: MockGraphOptions = {},
): CrowdfundGraph {
  const multiHopRatio = opts.multiHopRatio ?? 0.05
  const rand = mulberry32(opts.seed ?? 42)

  const seedCount = Math.max(3, Math.floor(targetNodeCount * 0.02))
  const hop0Invites = 8
  const hop1Count = seedCount * hop0Invites
  const hop2Remaining = Math.max(0, targetNodeCount - seedCount - hop1Count)
  const hop1Invites = Math.max(1, Math.floor(hop2Remaining / Math.max(1, hop1Count)))

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const summaries = new Map<string, AddressSummary>()

  function addNode(address: string, hop: number, committed: bigint, invitedBy: string[]) {
    const key = `${address}-${hop}`
    nodes.set(key, {
      address, hop,
      invitesReceived: invitedBy.length,
      committed, rawDeposited: committed,
      invitedBy,
      invitesUsed: 0, invitesAvailable: hop === 0 ? 16 : hop === 1 ? 8 : 0,
      allocatedArm: null, acceptedUsdc: null,
    })
  }

  function upsertSummary(address: string, hop: number, committed: bigint) {
    const existing = summaries.get(address)
    if (existing) {
      if (!existing.hops.includes(hop)) existing.hops.push(hop)
      existing.totalCommitted += committed
      existing.perHop.set(hop, (existing.perHop.get(hop) ?? 0n) + committed)
    } else {
      summaries.set(address, {
        address,
        hops: [hop],
        totalCommitted: committed,
        perHop: new Map([[hop, committed]]),
        displayInviter: '',
        allocatedArm: null, refundUsdc: null,
        allocatedPerHop: new Map(),
        armClaimed: false, refundClaimed: false, delegate: null,
      })
    }
  }

  // ── hop-0 seeds ──
  const seeds: string[] = []
  for (let i = 0; i < seedCount; i++) {
    const addr = fakeAddress(rand)
    seeds.push(addr)
    const committed = BigInt(Math.floor(rand() * 50_000) + 5_000) * 1_000_000n
    addNode(addr, 0, committed, ['armada'])
    upsertSummary(addr, 0, committed)
    edges.push({ fromAddress: 'armada', fromHop: -1, toAddress: addr, toHop: 0 })
  }

  // ── hop-1 invites ──
  const hop1s: string[] = []
  for (const seed of seeds) {
    for (let i = 0; i < hop0Invites; i++) {
      const addr = fakeAddress(rand)
      hop1s.push(addr)
      const committed = BigInt(Math.floor(rand() * 10_000) + 500) * 1_000_000n
      addNode(addr, 1, committed, [seed])
      upsertSummary(addr, 1, committed)
      edges.push({ fromAddress: seed, fromHop: 0, toAddress: addr, toHop: 1 })
      // bookkeeping
      const seedNode = nodes.get(`${seed}-0`)
      if (seedNode) seedNode.invitesUsed++
    }
  }

  // ── hop-2 invites ──
  let producedHop2 = 0
  for (const h1 of hop1s) {
    for (let i = 0; i < hop1Invites && producedHop2 < hop2Remaining; i++) {
      const addr = fakeAddress(rand)
      const committed = BigInt(Math.floor(rand() * 2_000) + 100) * 1_000_000n
      addNode(addr, 2, committed, [h1])
      upsertSummary(addr, 2, committed)
      edges.push({ fromAddress: h1, fromHop: 1, toAddress: addr, toHop: 2 })
      const h1Node = nodes.get(`${h1}-1`)
      if (h1Node) h1Node.invitesUsed++
      producedHop2++
    }
  }

  // ── multi-hop: some hop-1 addresses also appear at hop-2 ──
  const multiHopCount = Math.floor(hop1s.length * multiHopRatio)
  for (let i = 0; i < multiHopCount; i++) {
    const multi = hop1s[Math.floor(rand() * hop1s.length)]
    if (!multi) continue
    if (summaries.get(multi)?.hops.includes(2)) continue
    const inviter = seeds[Math.floor(rand() * seeds.length)]
    if (!inviter) continue
    const extraCommitted = BigInt(Math.floor(rand() * 500) + 50) * 1_000_000n
    addNode(multi, 2, extraCommitted, [inviter])
    upsertSummary(multi, 2, extraCommitted)
    edges.push({ fromAddress: inviter, fromHop: 0, toAddress: multi, toHop: 2 })
  }

  return { nodes, edges, summaries, events: [] }
}

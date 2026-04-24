// ABOUTME: Transforms CrowdfundGraph into a rooted tree used by radialLayout.
// ABOUTME: Pure functions — no React, no d3. Handles multi-hop merging and dedup.

import type { CrowdfundGraph } from './graph.js'

/** A node in the rooted tree of addresses. */
export interface TreeNode {
  id: string
  address: string
  label: string
  hop: number
  committed: bigint
  perHop: Map<number, bigint>
  hops: number[]
  isMultiHop: boolean
  invitesUsed: number
  invitesAvailable: number
  allocatedArm: bigint | null
  children: TreeNode[]
}

/**
 * Convert a CrowdfundGraph into a tree rooted at "Armada".
 *
 * Each address gets ONE TreeNode placed at its lowest hop (highest trust).
 * Multi-hop addresses merge into a single node with `isMultiHop: true`.
 * Children are determined by invite edges.
 */
export function graphToTree(
  graph: CrowdfundGraph,
  resolveENS: (addr: string) => string | null,
): TreeNode {
  const root: TreeNode = {
    id: 'armada',
    address: 'armada',
    label: 'Armada',
    hop: -1,
    committed: 0n,
    perHop: new Map(),
    hops: [],
    isMultiHop: false,
    invitesUsed: 0,
    invitesAvailable: 0,
    allocatedArm: null,
    children: [],
  }

  if (graph.nodes.size === 0) return root

  // Build summary-level data for each address
  const addressToNode = new Map<string, TreeNode>()
  for (const [, summary] of graph.summaries) {
    const addr = summary.address
    const lowestHop = summary.hops.length > 0 ? Math.min(...summary.hops) : 0
    const ens = resolveENS(addr)
    const label = ens ?? truncateAddr(addr)

    let totalInvitesUsed = 0
    let totalInvitesAvail = 0
    for (const hop of summary.hops) {
      const gNode = graph.nodes.get(`${addr}-${hop}`)
      if (gNode) {
        totalInvitesUsed += gNode.invitesUsed
        totalInvitesAvail += gNode.invitesAvailable
      }
    }

    addressToNode.set(addr, {
      id: addr,
      address: addr,
      label,
      hop: lowestHop,
      committed: summary.totalCommitted,
      perHop: new Map(summary.perHop),
      hops: [...summary.hops],
      isMultiHop: summary.hops.length > 1,
      invitesUsed: totalInvitesUsed,
      invitesAvailable: totalInvitesAvail,
      allocatedArm: summary.allocatedArm,
      children: [],
    })
  }

  // Determine parent for each address: use edges to find the inviter at the lowest hop
  // For each address, find which other address invited them (at their lowest hop).
  const parentMap = new Map<string, string>() // child address → parent address

  for (const edge of graph.edges) {
    const childAddr = edge.toAddress
    const parentAddr = edge.fromAddress

    // Skip self-invite edges (same address, different hop)
    if (childAddr === parentAddr) continue

    // Track the "best" parent: the one at the lowest fromHop
    const existing = parentMap.get(childAddr)
    if (!existing) {
      parentMap.set(childAddr, parentAddr)
    } else {
      // Find the edge that connects at the lowest hop
      const existingParentNode = addressToNode.get(existing)
      const candidateParentNode = addressToNode.get(parentAddr)
      if (existingParentNode && candidateParentNode) {
        if (candidateParentNode.hop < existingParentNode.hop) {
          parentMap.set(childAddr, parentAddr)
        }
      }
    }
  }

  // Build tree by attaching children to parents
  for (const [childAddr, parentAddr] of parentMap) {
    const childNode = addressToNode.get(childAddr)
    if (!childNode) continue

    if (parentAddr === 'armada') {
      root.children.push(childNode)
    } else {
      const parentNode = addressToNode.get(parentAddr)
      if (parentNode) {
        parentNode.children.push(childNode)
      } else {
        // Orphan — attach to root
        root.children.push(childNode)
      }
    }
  }

  // Handle addresses without a parent edge (shouldn't happen, but defensive)
  for (const [addr, node] of addressToNode) {
    if (!parentMap.has(addr)) {
      // This address has no incoming invite edge — check if it's a seed
      const hasRootEdge = graph.edges.some(
        (e) => e.fromAddress === 'armada' && e.toAddress === addr,
      )
      if (hasRootEdge) {
        root.children.push(node)
      }
      // else: isolated node, skip
    }
  }

  // Re-parent orphaned subtrees: if a node was never attached to the tree
  // (e.g., launch team address is not a seed but created invite edges),
  // move its children directly under root so they aren't lost.
  const reachable = new Set<string>()
  function markReachable(n: TreeNode) {
    reachable.add(n.address)
    for (const child of n.children) markReachable(child)
  }
  markReachable(root)

  for (const [addr, node] of addressToNode) {
    if (!reachable.has(addr) && node.children.length > 0) {
      // This node is unreachable but has children — re-parent them under root
      for (const child of node.children) {
        root.children.push(child)
      }
    }
  }

  // Sort children by committed amount (descending) for visual stability
  sortChildren(root)

  return root
}

/** Recursively sort children by committed amount (descending) */
function sortChildren(node: TreeNode): void {
  node.children.sort((a, b) => {
    // Sort by committed descending, then by address for stability
    const diff = Number(b.committed - a.committed)
    if (diff !== 0) return diff
    return a.address.localeCompare(b.address)
  })
  for (const child of node.children) {
    sortChildren(child)
  }
}

/**
 * Find addresses matching a search query.
 * Matches against address substring or ENS name (via tree labels).
 */
export function filterTree(root: TreeNode, query: string): Set<string> {
  const matched = new Set<string>()
  const lowerQuery = query.toLowerCase()

  function walk(node: TreeNode): void {
    if (node.address === 'armada') {
      // Always include root if any child matches
    } else {
      const addressMatch = node.address.toLowerCase().includes(lowerQuery)
      const labelMatch = node.label.toLowerCase().includes(lowerQuery)
      if (addressMatch || labelMatch) {
        matched.add(node.address)
      }
    }
    for (const child of node.children) {
      walk(child)
    }
  }

  walk(root)

  // If any node matches, include root
  if (matched.size > 0) {
    matched.add('armada')
  }

  return matched
}

/** Truncate an address for display */
function truncateAddr(addr: string): string {
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

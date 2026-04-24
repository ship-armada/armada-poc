// ABOUTME: Flattens a CrowdfundGraph into nodes + edges suitable for a d3-force radial layout.
// ABOUTME: Pure function — no React, no d3 at this layer.

import type { CrowdfundGraph } from './graph.js'
import { graphToTree, type TreeNode } from './treeLayout.js'

/** A node in the radial layout. Position fields are added by the simulation. */
export interface RadialNode {
  id: string
  address: string
  label: string
  /** -1 for the Armada root; 0..2 for participant hops. */
  hop: number
  hops: number[]
  isMultiHop: boolean
  committed: bigint
  parentId: string | null
}

/** An invite edge between two radial nodes, referenced by id. */
export interface RadialEdge {
  id: string
  source: string
  target: string
}

export interface RadialGraph {
  nodes: RadialNode[]
  edges: RadialEdge[]
}

/** Stable no-op ENS resolver — labels are not displayed in the spike view, so we
 *  skip caller-provided resolvers to avoid destabilising the target memo on every
 *  parent rerender (a fresh `() => null` closure would otherwise restart the sim). */
const NO_ENS: (addr: string) => string | null = () => null

/**
 * Build a flat {nodes, edges} structure from a CrowdfundGraph.
 * Reuses `graphToTree` so multi-hop collapse and parent selection match TreeView.
 */
export function buildRadialGraph(graph: CrowdfundGraph): RadialGraph {
  const tree = graphToTree(graph, NO_ENS)
  const nodes: RadialNode[] = []
  const edges: RadialEdge[] = []

  function walk(node: TreeNode, parentId: string | null): void {
    nodes.push({
      id: node.id,
      address: node.address,
      label: node.label,
      hop: node.hop,
      hops: [...node.hops],
      isMultiHop: node.isMultiHop,
      committed: node.committed,
      parentId,
    })

    if (parentId !== null) {
      edges.push({
        id: `${parentId}->${node.id}`,
        source: parentId,
        target: node.id,
      })
    }

    for (const child of node.children) {
      walk(child, node.id)
    }
  }

  walk(tree, null)
  return { nodes, edges }
}

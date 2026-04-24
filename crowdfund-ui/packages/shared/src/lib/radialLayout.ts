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

/** Angular sector assigned to a node for the sunburst-style layout. */
export interface AngleInfo {
  /** Sector midpoint angle in radians, measured from +x axis ccw. */
  angle: number
  /** Sector start angle. */
  angleMin: number
  /** Sector end angle. */
  angleMax: number
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

/**
 * Allocate an angular sector (wedge) to each node of a rooted tree, with each
 * node's sector sized proportionally to its subtree's total node count. The
 * root owns the full circle; children subdivide their parent's wedge. This is
 * the classic "sunburst" allocation and is what lets a custom d3-force pin
 * each subtree into its own angular slice (sector grouping).
 *
 * `gapFraction` reserves padding at each side of every parent's wedge, so
 * descendants can't reach the wedge boundary. This creates visible empty
 * space between adjacent branches at every ring depth. The default `0` is
 * equivalent to the classic sunburst (children fill the full wedge).
 *
 * `reservedAngle` (radians) removes two symmetric wedges — one centred at
 * the top (-π/2 in our SVG y-down convention) and one at the bottom (π/2) —
 * so descendants never occupy those angles. Useful for leaving room for ring
 * labels on the vertical axis. Allocation happens in a "virtual" angular
 * space of total size `2π - 2·reservedAngle`; each virtual angle is mapped
 * to a real angle that skips the reserved wedges.
 *
 * Nodes not reachable from `rootId` are omitted from the returned map.
 */
export function computeAngleMap(
  edges: RadialEdge[],
  rootId: string,
  gapFraction = 0,
  reservedAngle = 0,
): Map<string, AngleInfo> {
  // Build children adjacency from tree edges.
  const childrenOf = new Map<string, string[]>()
  for (const e of edges) {
    const arr = childrenOf.get(e.source) ?? []
    arr.push(e.target)
    childrenOf.set(e.source, arr)
  }

  // Subtree sizes (inclusive of the node itself).
  const sizes = new Map<string, number>()
  function computeSize(id: string): number {
    let size = 1
    for (const child of childrenOf.get(id) ?? []) {
      size += computeSize(child)
    }
    sizes.set(id, size)
    return size
  }
  computeSize(rootId)

  // Virtual → real angle mapping. When `reservedAngle` is 0 the allocation
  // runs in the full [0, 2π] and the mapping is identity. When nonzero,
  // allocation runs in [0, fullAllowed = 2·(π - reservedAngle)] and each
  // virtual angle lands in one of two arcs: the "right" arc (below top,
  // above bottom, through angle 0) or the "left" arc (below bottom, above
  // top, through angle π). Top (-π/2) and bottom (π/2) wedges stay empty.
  const halfAllowed = Math.PI - reservedAngle
  const fullAllowed = reservedAngle > 0 ? 2 * halfAllowed : 2 * Math.PI
  const virtualToReal =
    reservedAngle > 0
      ? (v: number): number =>
          v < halfAllowed
            ? -Math.PI / 2 + reservedAngle / 2 + v
            : Math.PI / 2 + reservedAngle / 2 + (v - halfAllowed)
      : (v: number): number => v

  // Recursive sector allocation. Children divide the PARENT's content wedge
  // proportional to their own subtree sizes (not to parent's total, which
  // would include the parent itself and leave a gap at the end of every
  // wedge). The root wedge uses no padding — padding at its boundary would
  // create a visible seam at the allocation start.
  const out = new Map<string, AngleInfo>()
  function assign(id: string, startAngle: number, endAngle: number): void {
    out.set(id, {
      angle: virtualToReal((startAngle + endAngle) / 2),
      angleMin: virtualToReal(startAngle),
      angleMax: virtualToReal(endAngle),
    })
    const children = childrenOf.get(id) ?? []
    if (children.length === 0) return

    const wedge = endAngle - startAngle
    const isFullWedge = Math.abs(wedge - fullAllowed) < 1e-9
    const pad = isFullWedge ? 0 : gapFraction * wedge
    const contentStart = startAngle + pad
    const contentEnd = endAngle - pad
    const contentWedge = contentEnd - contentStart

    const totalChildrenSize = children.reduce(
      (acc, c) => acc + (sizes.get(c) ?? 1),
      0,
    )
    let current = contentStart
    for (const child of children) {
      const childSize = sizes.get(child) ?? 1
      const span =
        totalChildrenSize > 0
          ? (childSize / totalChildrenSize) * contentWedge
          : contentWedge / children.length
      assign(child, current, current + span)
      current += span
    }
  }
  assign(rootId, 0, fullAllowed)
  return out
}

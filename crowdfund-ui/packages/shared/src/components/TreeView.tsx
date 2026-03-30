// ABOUTME: DAG visualization of the crowdfund invite tree using d3-hierarchy.
// ABOUTME: Renders ROOT → hop-0 → hop-1 → hop-2 with pan/zoom, selection, and tooltips.

import { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import * as d3Hierarchy from 'd3-hierarchy'
import * as d3Zoom from 'd3-zoom'
import * as d3Scale from 'd3-scale'
import * as d3Selection from 'd3-selection'
import type { CrowdfundGraph } from '../lib/graph.js'
import { graphToTree, filterTree, type TreeNode } from '../lib/treeLayout.js'
import { NodeDetail } from './NodeDetail.js'

export interface TreeViewProps {
  graph: CrowdfundGraph
  selectedAddress: string | null
  onSelectAddress: (addr: string | null) => void
  searchQuery: string
  phase: number
  resolveENS: (addr: string) => string | null
}

/** Color palette for hop levels */
const HOP_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b'] as const

function hopColor(hop: number): string {
  if (hop < 0) return '#6b7280' // root
  return HOP_COLORS[hop] ?? '#6b7280'
}

/** Tooltip state */
interface TooltipState {
  x: number
  y: number
  address: string
}

/** Tracks which multi-hop nodes are expanded */
type ExpandedSet = Set<string>

/** Collapsed subtree indicator */
const COLLAPSE_THRESHOLD = 20

export function TreeView(props: TreeViewProps) {
  const { graph, selectedAddress, onSelectAddress, searchQuery, phase, resolveENS } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [, setExpanded] = useState<ExpandedSet>(new Set())
  const [collapsedSubtrees, setCollapsedSubtrees] = useState<Set<string>>(new Set())
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  // Observe container size
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: Math.max(400, entry.contentRect.height),
        })
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Build tree structure from graph
  const tree = useMemo(
    () => graphToTree(graph, resolveENS),
    [graph, resolveENS],
  )

  // Search filter
  const matchedAddresses = useMemo(
    () => (searchQuery ? filterTree(tree, searchQuery) : null),
    [tree, searchQuery],
  )

  // Compute node size scale
  const maxCommitted = useMemo(() => {
    let max = 0n
    for (const summary of graph.summaries.values()) {
      if (summary.totalCommitted > max) max = summary.totalCommitted
    }
    return max
  }, [graph.summaries])

  const sizeScale = useMemo(
    () => d3Scale.scaleSqrt().domain([0, Number(maxCommitted) || 1]).range([4, 24]),
    [maxCommitted],
  )

  // Flatten tree for rendering, respecting collapse state
  const { flatNodes, flatEdges } = useMemo(() => {
    const nodes: Array<TreeNode & { x: number; y: number; depth: number }> = []
    const edges: Array<{ source: { x: number; y: number }; target: { x: number; y: number }; fromHop: number; toHop: number; isSelfInvite: boolean }> = []

    if (tree.children.length === 0) {
      // Empty state — just the root
      nodes.push({ ...tree, x: dimensions.width / 2, y: 40, depth: 0 })
      return { flatNodes: nodes, flatEdges: edges }
    }

    // Use d3 tree layout
    const root = d3Hierarchy.hierarchy(tree, (d) => {
      if (collapsedSubtrees.has(d.id)) return []
      return d.children
    })

    const treeLayout = d3Hierarchy.tree<TreeNode>()
      .size([dimensions.height - 80, dimensions.width - 160])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.5))

    treeLayout(root)

    // Walk the hierarchy and build flat arrays
    root.each((d) => {
      // For tree layout: x = vertical position, y = horizontal (depth-based)
      // We want hop columns left-to-right, so swap x/y
      const hopX = 80 + ((d.data.hop + 1) / 3) * (dimensions.width - 160)
      nodes.push({
        ...d.data,
        x: hopX,
        y: (d.x ?? 0) + 40, // d.x is the vertical spread from tree layout
        depth: d.depth,
      })

      if (d.parent) {
        const parentHopX = 80 + ((d.parent.data.hop + 1) / 3) * (dimensions.width - 160)
        edges.push({
          source: { x: parentHopX, y: (d.parent.x ?? 0) + 40 },
          target: { x: hopX, y: (d.x ?? 0) + 40 },
          fromHop: d.parent.data.hop,
          toHop: d.data.hop,
          isSelfInvite: d.parent.data.address === d.data.address,
        })
      }
    })

    return { flatNodes: nodes, flatEdges: edges }
  }, [tree, dimensions, collapsedSubtrees])

  // Set up zoom behavior
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const svgSelection = d3Selection.select(svg)
    const g = svgSelection.select<SVGGElement>('g.tree-content')

    const zoom = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString())
      })

    svgSelection.call(zoom)

    // Cleanup
    return () => {
      svgSelection.on('.zoom', null)
    }
  }, [])

  const handleNodeClick = useCallback((address: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (address === 'armada') return
    onSelectAddress(selectedAddress === address ? null : address)
  }, [selectedAddress, onSelectAddress])

  const handleBadgeClick = useCallback((address: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(address)) {
        next.delete(address)
      } else {
        next.add(address)
      }
      return next
    })
  }, [])

  const handleSubtreeToggle = useCallback((nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCollapsedSubtrees((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  const handleBackgroundClick = useCallback(() => {
    onSelectAddress(null)
  }, [onSelectAddress])

  const handleNodeHover = useCallback((address: string, e: React.MouseEvent) => {
    if (address === 'armada') return
    const svgRect = svgRef.current?.getBoundingClientRect()
    if (!svgRect) return
    setTooltip({
      x: e.clientX - svgRect.left,
      y: e.clientY - svgRect.top,
      address,
    })
  }, [])

  const handleNodeLeave = useCallback(() => {
    setTooltip(null)
  }, [])

  // Empty state
  if (graph.nodes.size === 0) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-6 text-center min-h-[400px] flex flex-col items-center justify-center"
      >
        <svg width="120" height="60">
          <text x="60" y="30" textAnchor="middle" className="fill-foreground text-sm font-medium">
            Armada
          </text>
        </svg>
        <div className="text-sm text-muted-foreground mt-2">Waiting for seeds...</div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="rounded-lg border border-border bg-card relative min-h-[400px]">
      {/* Hop column labels */}
      <div className="absolute top-2 left-0 right-0 flex justify-around text-xs text-muted-foreground z-10 pointer-events-none">
        <span>Root</span>
        <span>Seed (hop-0)</span>
        <span>Hop-1</span>
        <span>Hop-2</span>
      </div>

      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="cursor-grab active:cursor-grabbing"
        onClick={handleBackgroundClick}
      >
        <g className="tree-content">
          {/* Edges */}
          {flatEdges.map((edge, i) => {
            const dimmed = matchedAddresses !== null // search is active
            const edgeOpacity = dimmed ? 0.1 : 0.4

            return (
              <line
                key={`edge-${i}`}
                x1={edge.source.x}
                y1={edge.source.y}
                x2={edge.target.x}
                y2={edge.target.y}
                stroke={hopColor(edge.toHop)}
                strokeWidth={1.5}
                strokeOpacity={edgeOpacity}
                strokeDasharray={edge.fromHop === -1 ? '4 2' : undefined}
              />
            )
          })}

          {/* Nodes */}
          {flatNodes.map((node) => {
            const isRoot = node.id === 'armada'
            const isSelected = selectedAddress === node.address
            const isSearchMatch = matchedAddresses === null || matchedAddresses.has(node.address)
            const nodeOpacity = matchedAddresses !== null && !isSearchMatch ? 0.2 : 1
            const radius = isRoot ? 0 : sizeScale(Number(node.committed))
            const hasChildren = node.children.length > 0
            const isCollapsed = collapsedSubtrees.has(node.id)
            const childCount = node.children.length

            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                opacity={nodeOpacity}
                className="cursor-pointer"
                onClick={(e) => handleNodeClick(node.address, e)}
                onMouseEnter={(e) => handleNodeHover(node.address, e)}
                onMouseLeave={handleNodeLeave}
              >
                {isRoot ? (
                  // Root node — text label
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-foreground text-xs font-medium"
                  >
                    Armada
                  </text>
                ) : (
                  <>
                    {/* Node circle */}
                    {node.isMultiHop ? (
                      // Multi-hop: segmented fill
                      <>
                        <circle
                          r={radius}
                          fill="none"
                          stroke={isSelected ? '#ffffff' : hopColor(node.hop)}
                          strokeWidth={isSelected ? 2.5 : 1.5}
                        />
                        {node.hops.map((h: number, idx: number) => {
                          const angle = (idx / node.hops.length) * Math.PI * 2 - Math.PI / 2
                          const nextAngle = ((idx + 1) / node.hops.length) * Math.PI * 2 - Math.PI / 2
                          const largeArc = nextAngle - angle > Math.PI ? 1 : 0
                          const x1 = Math.cos(angle) * radius
                          const y1 = Math.sin(angle) * radius
                          const x2 = Math.cos(nextAngle) * radius
                          const y2 = Math.sin(nextAngle) * radius
                          return (
                            <path
                              key={h}
                              d={`M 0 0 L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`}
                              fill={hopColor(h)}
                              fillOpacity={0.6}
                            />
                          )
                        })}
                      </>
                    ) : (
                      // Single hop
                      <circle
                        r={radius}
                        fill={node.committed > 0n ? hopColor(node.hop) : 'none'}
                        fillOpacity={node.committed > 0n ? 0.6 : 0}
                        stroke={isSelected ? '#ffffff' : hopColor(node.hop)}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                      />
                    )}

                    {/* Multi-hop badge */}
                    {node.isMultiHop && (
                      <g
                        transform={`translate(${radius + 2}, ${-radius - 2})`}
                        onClick={(e) => handleBadgeClick(node.address, e)}
                        className="cursor-pointer"
                      >
                        <rect
                          x={-8}
                          y={-7}
                          width={16}
                          height={14}
                          rx={3}
                          fill="#1e293b"
                          stroke="#475569"
                          strokeWidth={0.5}
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="fill-foreground"
                          fontSize={9}
                        >
                          ×{node.hops.length}
                        </text>
                      </g>
                    )}

                    {/* Collapse/expand indicator for large subtrees */}
                    {hasChildren && childCount > COLLAPSE_THRESHOLD && (
                      <g
                        transform={`translate(${radius + 2}, ${radius + 2})`}
                        onClick={(e) => handleSubtreeToggle(node.id, e)}
                        className="cursor-pointer"
                      >
                        <rect
                          x={-10}
                          y={-6}
                          width={20}
                          height={12}
                          rx={2}
                          fill="#1e293b"
                          stroke="#475569"
                          strokeWidth={0.5}
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="fill-muted-foreground"
                          fontSize={8}
                        >
                          {isCollapsed ? `+${childCount}` : '−'}
                        </text>
                      </g>
                    )}

                    {/* Selection ring */}
                    {isSelected && (
                      <circle
                        r={radius + 4}
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth={1}
                        strokeOpacity={0.5}
                      />
                    )}

                    {/* Label for larger nodes */}
                    {radius > 12 && (
                      <text
                        y={radius + 14}
                        textAnchor="middle"
                        className="fill-muted-foreground"
                        fontSize={9}
                      >
                        {node.label}
                      </text>
                    )}
                  </>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {/* Tooltip */}
      {tooltip && graph.summaries.has(tooltip.address) && (
        <div
          className="absolute z-20 rounded-lg border border-border bg-popover p-3 shadow-lg max-w-xs pointer-events-none"
          style={{
            left: Math.min(tooltip.x + 12, dimensions.width - 280),
            top: Math.min(tooltip.y + 12, dimensions.height - 200),
          }}
        >
          <NodeDetail
            summary={graph.summaries.get(tooltip.address)!}
            hopNodes={
              [...graph.nodes.values()].filter((n) => n.address === tooltip.address)
            }
            resolveENS={resolveENS}
            phase={phase}
          />
        </div>
      )}
    </div>
  )
}

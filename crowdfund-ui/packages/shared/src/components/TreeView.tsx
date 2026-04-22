// ABOUTME: DAG visualization of the crowdfund invite tree using d3-hierarchy.
// ABOUTME: Renders ROOT → hop-0 → hop-1 → hop-2 with pan/zoom, selection, and tooltips.

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import * as d3Hierarchy from 'd3-hierarchy'
import * as d3Zoom from 'd3-zoom'
import * as d3Scale from 'd3-scale'
import * as d3Selection from 'd3-selection'
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react'
import type { CrowdfundGraph } from '../lib/graph.js'
import { graphToTree, filterTree, type TreeNode } from '../lib/treeLayout.js'
import { NodeDetail } from './NodeDetail.js'
import { Button } from './ui/button.js'

export interface TreeViewProps {
  graph: CrowdfundGraph
  selectedAddress: string | null
  onSelectAddress: (addr: string | null) => void
  onHoverAddress?: (addr: string | null) => void
  searchQuery: string
  phase: number
  resolveENS: (addr: string) => string | null
  connectedAddress?: string | null
  /** When true with an empty graph, renders a pulsing placeholder instead of the "Waiting for seeds" empty panel. */
  isLoading?: boolean
}

/**
 * Hop-level colour token accessor. Returns CSS `var()` strings so values
 * live in the shared theme (packages/shared/src/styles/theme.css).
 */
function hopColor(hop: number): string {
  if (hop === 0) return 'var(--hop-0)'
  if (hop === 1) return 'var(--hop-1)'
  if (hop === 2) return 'var(--hop-2)'
  return 'var(--hop-root)'
}

/** Tooltip state */
interface TooltipState {
  x: number
  y: number
  address: string
}

/** Collapsed subtree indicator */
const COLLAPSE_THRESHOLD = 20

/** CSS transition for smooth enter/position changes */
const NODE_TRANSITION = 'transform 500ms ease, opacity 300ms ease'
const EDGE_TRANSITION = 'opacity 300ms ease'

/** Memoized node component to avoid re-rendering all nodes on selection changes */
const TreeNodeEl = React.memo(function TreeNodeEl(props: {
  node: TreeNode & { x: number; y: number }
  radius: number
  isRoot: boolean
  isSelected: boolean
  isConnected: boolean
  isSearchMatch: boolean
  searchActive: boolean
  isExpanded: boolean
  isCollapsed: boolean
  childCount: number
  onClick: (address: string, e: React.MouseEvent) => void
  onBadgeClick: (address: string, e: React.MouseEvent) => void
  onSubtreeToggle: (nodeId: string, e: React.MouseEvent) => void
  onMouseEnter: (address: string, e: React.MouseEvent) => void
  onMouseLeave: () => void
}) {
  const {
    node, radius, isRoot, isSelected, isConnected, isSearchMatch, searchActive,
    isExpanded, isCollapsed, childCount,
    onClick, onBadgeClick, onSubtreeToggle, onMouseEnter, onMouseLeave,
  } = props

  const nodeOpacity = searchActive && !isSearchMatch ? 0.2 : 1
  const hasChildren = childCount > 0

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      opacity={nodeOpacity}
      className="cursor-pointer"
      style={{ transition: NODE_TRANSITION }}
      onClick={(e) => onClick(node.address, e)}
      onMouseEnter={(e) => onMouseEnter(node.address, e)}
      onMouseLeave={onMouseLeave}
    >
      {isRoot ? (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground text-xs font-medium"
        >
          Armada
        </text>
      ) : (
        <>
          {/* Connected address glow ring */}
          {isConnected && (
            <circle
              r={radius + 4}
              fill="none"
              style={{ stroke: 'var(--hop-connected)' }}
              strokeWidth={2}
              strokeOpacity={0.6}
            />
          )}
          {node.isMultiHop ? (
            <>
              <circle
                r={radius}
                fill="none"
                style={{ stroke: isSelected ? 'var(--hop-selected)' : hopColor(node.hop) }}
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
                    style={{ fill: hopColor(h) }}
                    fillOpacity={0.6}
                  />
                )
              })}
            </>
          ) : (
            <circle
              r={radius}
              style={{
                fill: node.committed > 0n ? hopColor(node.hop) : 'none',
                stroke: isSelected ? 'var(--hop-selected)' : hopColor(node.hop),
              }}
              fillOpacity={node.committed > 0n ? 0.6 : 0}
              strokeWidth={isSelected ? 2.5 : 1.5}
            />
          )}

          {/* Multi-hop badge — click to expand/collapse per-hop detail */}
          {node.isMultiHop && (
            <g
              transform={`translate(${radius + 2}, ${-radius - 2})`}
              onClick={(e) => onBadgeClick(node.address, e)}
              className="cursor-pointer"
            >
              <rect
                x={-8}
                y={-7}
                width={16}
                height={14}
                rx={3}
                style={{
                  fill: isExpanded ? 'var(--muted)' : 'var(--card)',
                  stroke: isExpanded ? 'var(--muted-foreground)' : 'var(--border)',
                }}
                strokeWidth={0.5}
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-foreground"
                fontSize={9}
              >
                {isExpanded ? '−' : `×${node.hops.length}`}
              </text>
            </g>
          )}

          {/* Collapse/expand indicator for large subtrees */}
          {hasChildren && childCount > COLLAPSE_THRESHOLD && (
            <g
              transform={`translate(${radius + 2}, ${radius + 2})`}
              onClick={(e) => onSubtreeToggle(node.id, e)}
              className="cursor-pointer"
            >
              <rect
                x={-10}
                y={-6}
                width={20}
                height={12}
                rx={2}
                style={{ fill: 'var(--card)', stroke: 'var(--border)' }}
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
              style={{ stroke: 'var(--hop-selected)' }}
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

          {/* Expanded per-hop breakdown labels */}
          {isExpanded && node.isMultiHop && (
            <g transform={`translate(${radius + 20}, -${(node.hops.length - 1) * 7})`}>
              {node.hops.map((h: number, idx: number) => {
                const amount = node.perHop.get(h) ?? 0n
                const display = Number(amount / (10n ** 6n))
                return (
                  <text
                    key={h}
                    y={idx * 14}
                    className="fill-muted-foreground"
                    fontSize={8}
                  >
                    <tspan style={{ fill: hopColor(h) }}>●</tspan> hop-{h}: ${display.toLocaleString()}
                  </text>
                )
              })}
            </g>
          )}
        </>
      )}
    </g>
  )
})

/** Memoized edge component */
const TreeEdge = React.memo(function TreeEdge(props: {
  edge: { source: { x: number; y: number }; target: { x: number; y: number }; fromHop: number; toHop: number; isSelfInvite: boolean }
  dimmed: boolean
  isInviterChain: boolean
}) {
  const { edge, dimmed, isInviterChain } = props
  const edgeOpacity = dimmed ? 0.1 : isInviterChain ? 0.8 : 0.4

  // Self-invite: render curved loop
  if (edge.isSelfInvite) {
    const cx = (edge.source.x + edge.target.x) / 2
    const cy = (edge.source.y + edge.target.y) / 2
    const dx = edge.target.x - edge.source.x
    const dy = edge.target.y - edge.source.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const offset = Math.max(30, dist * 0.5)
    // Curve perpendicular to the line between source and target
    const nx = -dy / (dist || 1) * offset
    const ny = dx / (dist || 1) * offset

    return (
      <path
        d={`M ${edge.source.x} ${edge.source.y} Q ${cx + nx} ${cy + ny} ${edge.target.x} ${edge.target.y}`}
        fill="none"
        strokeWidth={isInviterChain ? 2 : 1.5}
        strokeOpacity={edgeOpacity}
        strokeDasharray="2 2"
        style={{
          stroke: isInviterChain ? 'var(--graph-edge-chain)' : hopColor(edge.toHop),
          transition: EDGE_TRANSITION,
        }}
      />
    )
  }

  return (
    <line
      x1={edge.source.x}
      y1={edge.source.y}
      x2={edge.target.x}
      y2={edge.target.y}
      strokeWidth={isInviterChain ? 2 : 1.5}
      strokeOpacity={edgeOpacity}
      strokeDasharray={edge.fromHop === -1 ? '4 2' : undefined}
      style={{
        stroke: isInviterChain ? 'var(--graph-edge-chain)' : hopColor(edge.toHop),
        transition: EDGE_TRANSITION,
      }}
    />
  )
})

export function TreeView(props: TreeViewProps) {
  const { graph, selectedAddress, onSelectAddress, onHoverAddress, searchQuery, phase, resolveENS, connectedAddress, isLoading } = props
  // Callback ref via state: the interactive SVG only mounts on the main render path
  // (loading / empty-state returns bail before rendering it). A plain `useRef` + `useEffect([])`
  // binds once at mount — when the SVG isn't in the tree yet — and never re-runs to pick up the
  // element when it appears. State triggers the zoom-binding effect whenever the element arrives.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null)
  const zoomBehaviorRef = useRef<d3Zoom.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
    const edges: Array<{ source: { x: number; y: number }; target: { x: number; y: number }; fromHop: number; toHop: number; isSelfInvite: boolean; sourceAddr: string; targetAddr: string }> = []

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

    // `.nodeSize([spacing, 0])` gives each leaf a fixed vertical slot rather than
    // squeezing the whole tree into the viewport height. At fan-outs > ~20, the
    // old `.size(...)` approach collapsed leaves into overlapping pixels; with
    // nodeSize the tree grows as tall as it needs and the user pans / zooms.
    const VERTICAL_SPACING = 40
    const treeLayout = d3Hierarchy.tree<TreeNode>()
      .nodeSize([VERTICAL_SPACING, 0])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.5))

    treeLayout(root)

    // nodeSize-based layout produces signed, root-centred y-coordinates.
    // Shift so the topmost node lands just below the hop-column labels.
    let minLayoutX = Infinity
    root.each((d) => { if ((d.x ?? 0) < minLayoutX) minLayoutX = d.x ?? 0 })
    const yOffset = 40 - minLayoutX

    // Walk the hierarchy and build flat arrays
    root.each((d) => {
      // For tree layout: x = vertical position, y = horizontal (depth-based)
      // We want hop columns left-to-right, so swap x/y
      const hopX = 80 + ((d.data.hop + 1) / 3) * (dimensions.width - 160)
      nodes.push({
        ...d.data,
        x: hopX,
        y: (d.x ?? 0) + yOffset,
        depth: d.depth,
      })

      if (d.parent) {
        const parentHopX = 80 + ((d.parent.data.hop + 1) / 3) * (dimensions.width - 160)
        edges.push({
          source: { x: parentHopX, y: (d.parent.x ?? 0) + yOffset },
          target: { x: hopX, y: (d.x ?? 0) + yOffset },
          fromHop: d.parent.data.hop,
          toHop: d.data.hop,
          isSelfInvite: d.parent.data.address === d.data.address,
          sourceAddr: d.parent.data.address,
          targetAddr: d.data.address,
        })
      }
    })

    return { flatNodes: nodes, flatEdges: edges }
  }, [tree, dimensions, collapsedSubtrees])

  // Compute inviter chain: set of (sourceAddr, targetAddr) pairs on path from connected address to ROOT
  const inviterChainEdges = useMemo(() => {
    const chainEdges = new Set<string>()
    if (!connectedAddress) return chainEdges

    const connAddr = connectedAddress.toLowerCase()
    // Build child→parent lookup from edges
    const parentOf = new Map<string, string>()
    for (const edge of flatEdges) {
      if (!edge.isSelfInvite) {
        parentOf.set(edge.targetAddr, edge.sourceAddr)
      }
    }

    // Walk from connected address up to root, marking each edge
    let current = connAddr
    while (current && current !== 'armada') {
      const parent = parentOf.get(current)
      if (!parent) break
      chainEdges.add(`${parent}->${current}`)
      current = parent
    }
    return chainEdges
  }, [connectedAddress, flatEdges])

  // Set up zoom behavior
  useEffect(() => {
    if (!svgEl) return

    const svgSelection = d3Selection.select(svgEl)
    const g = svgSelection.select<SVGGElement>('g.tree-content')

    const zoom = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString())
      })

    svgSelection.call(zoom)
    zoomBehaviorRef.current = zoom

    // Cleanup
    return () => {
      svgSelection.on('.zoom', null)
      zoomBehaviorRef.current = null
    }
  }, [svgEl])

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
    const svgRect = svgEl?.getBoundingClientRect()
    if (!svgRect) return
    setTooltip({
      x: e.clientX - svgRect.left,
      y: e.clientY - svgRect.top,
      address,
    })
    onHoverAddress?.(address)
  }, [svgEl, onHoverAddress])

  const handleNodeLeave = useCallback(() => {
    setTooltip(null)
    onHoverAddress?.(null)
  }, [onHoverAddress])

  // Imperative zoom controls — mirror what xyflow ships via <Controls>.
  const handleZoomIn = useCallback(() => {
    if (!svgEl || !zoomBehaviorRef.current) return
    d3Selection.select(svgEl).transition().duration(200).call(zoomBehaviorRef.current.scaleBy, 1.3)
  }, [svgEl])

  const handleZoomOut = useCallback(() => {
    if (!svgEl || !zoomBehaviorRef.current) return
    d3Selection.select(svgEl).transition().duration(200).call(zoomBehaviorRef.current.scaleBy, 1 / 1.3)
  }, [svgEl])

  const handleFitView = useCallback(() => {
    if (!svgEl || !zoomBehaviorRef.current || flatNodes.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of flatNodes) {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    const pad = 60
    const contentW = (maxX - minX) + pad * 2
    const contentH = (maxY - minY) + pad * 2
    const scale = Math.min(dimensions.width / contentW, dimensions.height / contentH, 4)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const tx = dimensions.width / 2 - cx * scale
    const ty = dimensions.height / 2 - cy * scale
    const transform = d3Zoom.zoomIdentity.translate(tx, ty).scale(scale)
    d3Selection.select(svgEl).transition().duration(300).call(zoomBehaviorRef.current.transform, transform)
  }, [svgEl, flatNodes, dimensions])

  // Loading placeholder — pulsing grey circle while the first fetch is in flight.
  if (isLoading && graph.nodes.size === 0) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-6 min-h-[400px] flex items-center justify-center"
      >
        <div className="size-24 rounded-full bg-muted animate-pulse" />
      </div>
    )
  }

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

      {/* Zoom controls — mirror xyflow's <Controls> for fair A/B comparison */}
      <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-0.5 rounded-md border border-border bg-card/80 backdrop-blur-sm p-1 shadow-sm">
        <Button variant="ghost" size="icon" className="size-7" onClick={handleZoomIn} aria-label="Zoom in">
          <ZoomIn className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={handleZoomOut} aria-label="Zoom out">
          <ZoomOut className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={handleFitView} aria-label="Fit view">
          <Maximize className="size-4" />
        </Button>
      </div>

      <svg
        ref={setSvgEl}
        width={dimensions.width}
        height={dimensions.height}
        className="cursor-grab active:cursor-grabbing"
        onClick={handleBackgroundClick}
      >
        <g className="tree-content">
          {/* Edges */}
          {flatEdges.map((edge, i) => {
            // Selective edge dimming: dim only edges where neither endpoint matches search
            const edgeDimmed = matchedAddresses !== null &&
              !flatNodes.some((n) =>
                matchedAddresses.has(n.address) &&
                ((Math.abs(n.x - edge.source.x) < 1 && Math.abs(n.y - edge.source.y) < 1) ||
                 (Math.abs(n.x - edge.target.x) < 1 && Math.abs(n.y - edge.target.y) < 1))
              )

            return (
              <TreeEdge key={`edge-${i}`} edge={edge} dimmed={edgeDimmed} isInviterChain={inviterChainEdges.has(`${edge.sourceAddr}->${edge.targetAddr}`)} />
            )
          })}

          {/* Nodes */}
          {flatNodes.map((node) => {
            const isRoot = node.id === 'armada'
            const radius = isRoot ? 0 : sizeScale(Number(node.committed))

            return (
              <TreeNodeEl
                key={node.id}
                node={node}
                radius={radius}
                isRoot={isRoot}
                isSelected={selectedAddress === node.address}
                isConnected={!!connectedAddress && node.address === connectedAddress.toLowerCase()}
                isSearchMatch={matchedAddresses === null || matchedAddresses.has(node.address)}
                searchActive={matchedAddresses !== null}
                isExpanded={expanded.has(node.address)}
                isCollapsed={collapsedSubtrees.has(node.id)}
                childCount={node.children.length}
                onClick={handleNodeClick}
                onBadgeClick={handleBadgeClick}
                onSubtreeToggle={handleSubtreeToggle}
                onMouseEnter={handleNodeHover}
                onMouseLeave={handleNodeLeave}
              />
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

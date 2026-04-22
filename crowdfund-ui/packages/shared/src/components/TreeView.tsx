// ABOUTME: DAG visualization of the crowdfund invite tree using @xyflow/react (React Flow).
// ABOUTME: Custom node/edge types; d3-hierarchy still computes layout positions fed into React Flow.

import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import * as d3Hierarchy from 'd3-hierarchy'
import * as d3Scale from 'd3-scale'
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Panel,
  Handle,
  Position,
  BaseEdge,
  getStraightPath,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Copy, Crosshair, Search, Table2 } from 'lucide-react'
import { toast } from 'sonner'

import type { CrowdfundGraph, AddressSummary, GraphNode } from '../lib/graph.js'
import { graphToTree, filterTree, type TreeNode } from '../lib/treeLayout.js'
import { NodeDetail } from './NodeDetail.js'
import { IdenticonSvg } from './IdenticonSvg.js'
import { HoverCard, HoverCardTrigger, HoverCardContent } from './ui/hover-card.js'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.js'
import { Button } from './ui/button.js'
import { Separator } from './ui/separator.js'
import { GraphLegend } from './GraphLegend.js'

interface TreeViewCtxValue {
  getSummary: (address: string) => AddressSummary | undefined
  getHopNodes: (address: string) => GraphNode[]
  resolveENS: (address: string) => string | null
  phase: number
  onSelectAddress: (address: string | null) => void
}
const TreeViewContext = React.createContext<TreeViewCtxValue | null>(null)

/** Below this node radius, identicons are illegible — fall back to a solid coloured circle. */
const IDENTICON_MIN_RADIUS = 10

export interface TreeViewProps {
  graph: CrowdfundGraph
  selectedAddress: string | null
  onSelectAddress: (addr: string | null) => void
  onHoverAddress?: (addr: string | null) => void
  searchQuery: string
  phase: number
  resolveENS: (addr: string) => string | null
  connectedAddress?: string | null
  isLoading?: boolean
}

/** Fixed container size for custom nodes. d3 layout outputs centers, so we translate by NODE_HALF. */
const NODE_SIZE = 80
const NODE_HALF = NODE_SIZE / 2
const COLLAPSE_THRESHOLD = 20

function hopColor(hop: number): string {
  if (hop === 0) return 'var(--hop-0)'
  if (hop === 1) return 'var(--hop-1)'
  if (hop === 2) return 'var(--hop-2)'
  return 'var(--hop-root)'
}

// ────────────────────────── Custom node types ──────────────────────────

interface ParticipantNodeData extends Record<string, unknown> {
  address: string
  label: string
  hop: number
  hops: number[]
  isMultiHop: boolean
  committed: bigint
  perHop: Map<number, bigint>
  radius: number
  isSelected: boolean
  isConnected: boolean
  isSearchMatch: boolean
  searchActive: boolean
  isExpanded: boolean
  isCollapsed: boolean
  childCount: number
  onBadgeClick: (address: string) => void
  onSubtreeToggle: (nodeId: string) => void
  nodeId: string
}

function ParticipantNode({ data }: NodeProps<Node<ParticipantNodeData>>) {
  const d = data
  const ctx = useContext(TreeViewContext)
  const nodeOpacity = d.searchActive && !d.isSearchMatch ? 0.2 : 1
  const hasChildren = d.childCount > 0
  // Identicons render only for single-hop, committed, large-enough nodes.
  // Multi-hop nodes keep their pie-slice rendering; tiny nodes stay as solid circles.
  const showIdenticon = !d.isMultiHop && d.committed > 0n && d.radius >= IDENTICON_MIN_RADIUS
  const identiconSize = Math.floor(d.radius * 2)

  const summary = ctx?.getSummary(d.address)
  const hopNodes = ctx ? ctx.getHopNodes(d.address) : []
  const detailBody = summary ? (
    <NodeDetail summary={summary} hopNodes={hopNodes} resolveENS={ctx?.resolveENS} phase={ctx?.phase ?? 0} />
  ) : null

  const copyAddress = useCallback(() => {
    navigator.clipboard.writeText(d.address).then(
      () => toast.success('Address copied'),
      () => toast.error('Clipboard write failed'),
    )
  }, [d.address])

  const innerContent = (
    <div
      style={{
        width: NODE_SIZE,
        height: NODE_SIZE,
        position: 'relative',
        opacity: nodeOpacity,
        transition: 'opacity 300ms ease',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />

      {showIdenticon && (
        <div
          style={{
            position: 'absolute',
            left: NODE_HALF - d.radius,
            top: NODE_HALF - d.radius,
            width: identiconSize,
            height: identiconSize,
            pointerEvents: 'none',
          }}
        >
          <IdenticonSvg address={d.address} size={identiconSize} />
        </div>
      )}

      <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: 'visible', position: 'relative' }}>
        <g transform={`translate(${NODE_HALF}, ${NODE_HALF})`}>
          {d.isConnected && (
            <circle
              r={d.radius + 4}
              fill="none"
              style={{ stroke: 'var(--hop-connected)' }}
              strokeWidth={2}
              strokeOpacity={0.6}
            />
          )}

          {d.isMultiHop ? (
            <>
              <circle
                r={d.radius}
                fill="none"
                style={{ stroke: d.isSelected ? 'var(--hop-selected)' : hopColor(d.hop) }}
                strokeWidth={d.isSelected ? 2.5 : 1.5}
              />
              {d.hops.map((h: number, idx: number) => {
                const angle = (idx / d.hops.length) * Math.PI * 2 - Math.PI / 2
                const nextAngle = ((idx + 1) / d.hops.length) * Math.PI * 2 - Math.PI / 2
                const largeArc = nextAngle - angle > Math.PI ? 1 : 0
                const x1 = Math.cos(angle) * d.radius
                const y1 = Math.sin(angle) * d.radius
                const x2 = Math.cos(nextAngle) * d.radius
                const y2 = Math.sin(nextAngle) * d.radius
                return (
                  <path
                    key={h}
                    d={`M 0 0 L ${x1} ${y1} A ${d.radius} ${d.radius} 0 ${largeArc} 1 ${x2} ${y2} Z`}
                    style={{ fill: hopColor(h) }}
                    fillOpacity={0.6}
                  />
                )
              })}
            </>
          ) : (
            <circle
              r={d.radius}
              style={{
                fill: showIdenticon
                  ? 'none'
                  : d.committed > 0n ? hopColor(d.hop) : 'none',
                stroke: d.isSelected ? 'var(--hop-selected)' : hopColor(d.hop),
              }}
              fillOpacity={showIdenticon ? 0 : d.committed > 0n ? 0.6 : 0}
              strokeWidth={d.isSelected ? 2.5 : 1.5}
            />
          )}

          {d.isMultiHop && (
            <g
              transform={`translate(${d.radius + 2}, ${-d.radius - 2})`}
              onClick={(e) => {
                e.stopPropagation()
                d.onBadgeClick(d.address)
              }}
              style={{ cursor: 'pointer' }}
            >
              <rect
                x={-8} y={-7} width={16} height={14} rx={3}
                style={{
                  fill: d.isExpanded ? 'var(--muted)' : 'var(--card)',
                  stroke: d.isExpanded ? 'var(--muted-foreground)' : 'var(--border)',
                }}
                strokeWidth={0.5}
              />
              <text
                textAnchor="middle" dominantBaseline="central"
                className="fill-foreground" fontSize={9}
              >
                {d.isExpanded ? '−' : `×${d.hops.length}`}
              </text>
            </g>
          )}

          {hasChildren && d.childCount > COLLAPSE_THRESHOLD && (
            <g
              transform={`translate(${d.radius + 2}, ${d.radius + 2})`}
              onClick={(e) => {
                e.stopPropagation()
                d.onSubtreeToggle(d.nodeId)
              }}
              style={{ cursor: 'pointer' }}
            >
              <rect
                x={-10} y={-6} width={20} height={12} rx={2}
                style={{ fill: 'var(--card)', stroke: 'var(--border)' }}
                strokeWidth={0.5}
              />
              <text
                textAnchor="middle" dominantBaseline="central"
                className="fill-muted-foreground" fontSize={8}
              >
                {d.isCollapsed ? `+${d.childCount}` : '−'}
              </text>
            </g>
          )}

          {d.isSelected && (
            <circle
              r={d.radius + 4} fill="none"
              style={{ stroke: 'var(--hop-selected)' }}
              strokeWidth={1} strokeOpacity={0.5}
            />
          )}

          {d.radius > 12 && (
            <text
              y={d.radius + 14}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={9}
            >
              {d.label}
            </text>
          )}
        </g>
      </svg>
    </div>
  )

  // If we don't have access to graph data (e.g. rendered before Provider mounts), skip HoverCard/Popover.
  if (!summary || !detailBody) return innerContent

  return (
    <Popover
      open={d.isSelected}
      onOpenChange={(open) => {
        if (!open) ctx?.onSelectAddress(null)
      }}
    >
      <HoverCard openDelay={180} closeDelay={120}>
        <PopoverTrigger asChild>
          <HoverCardTrigger asChild>{innerContent}</HoverCardTrigger>
        </PopoverTrigger>
        {/* Hover peek — suppressed while the click-pinned Popover is open. */}
        {!d.isSelected && (
          <HoverCardContent side="right" align="start" className="w-72">
            {detailBody}
          </HoverCardContent>
        )}
      </HoverCard>
      <PopoverContent side="right" align="start" className="w-80 space-y-2">
        {detailBody}
        <Separator />
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={copyAddress}>
            <Copy className="size-3.5" />
            Copy address
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => ctx?.onSelectAddress(d.address)}
            aria-label="View in table"
          >
            <Table2 className="size-3.5" />
            View in table
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface RootNodeData extends Record<string, unknown> {
  label: string
}

function RootNode({ data }: NodeProps<Node<RootNodeData>>) {
  return (
    <div
      style={{
        width: NODE_SIZE, height: NODE_SIZE,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
      <span className="text-xs font-medium text-foreground">{data.label}</span>
    </div>
  )
}

// ────────────────────────── Custom edge type ──────────────────────────

interface InviteEdgeData extends Record<string, unknown> {
  fromHop: number
  toHop: number
  isSelfInvite: boolean
  isInviterChain: boolean
  dimmed: boolean
}

function InviteEdge(props: EdgeProps<Edge<InviteEdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, data, id } = props
  if (!data) return null

  const edgeOpacity = data.dimmed ? 0.1 : data.isInviterChain ? 0.8 : 0.4
  const stroke = data.isInviterChain ? 'var(--graph-edge-chain)' : hopColor(data.toHop)
  const strokeWidth = data.isInviterChain ? 2 : 1.5

  if (data.isSelfInvite) {
    const cx = (sourceX + targetX) / 2
    const cy = (sourceY + targetY) / 2
    const dx = targetX - sourceX
    const dy = targetY - sourceY
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const offset = Math.max(30, dist * 0.5)
    const nx = -dy / dist * offset
    const ny = dx / dist * offset
    const path = `M ${sourceX} ${sourceY} Q ${cx + nx} ${cy + ny} ${targetX} ${targetY}`
    return (
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke, strokeWidth, strokeOpacity: edgeOpacity, strokeDasharray: '2 2' }}
      />
    )
  }

  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  return (
    <BaseEdge
      id={id}
      path={path}
      style={{
        stroke,
        strokeWidth,
        strokeOpacity: edgeOpacity,
        strokeDasharray: data.fromHop === -1 ? '4 2' : undefined,
      }}
    />
  )
}

const nodeTypes = { participant: ParticipantNode, root: RootNode }
const edgeTypes = { invite: InviteEdge }

// ────────────────────────── TreeView core ──────────────────────────

function TreeViewInner(props: TreeViewProps) {
  const { graph, selectedAddress, onSelectAddress, onHoverAddress, searchQuery, phase, resolveENS, connectedAddress } = props
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedSubtrees, setCollapsedSubtrees] = useState<Set<string>>(new Set())
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const containerRef = React.useRef<HTMLDivElement>(null)
  const rf = useReactFlow()

  const ctxValue = useMemo<TreeViewCtxValue>(() => ({
    getSummary: (addr) => graph.summaries.get(addr),
    getHopNodes: (addr) => [...graph.nodes.values()].filter((n) => n.address === addr),
    resolveENS,
    phase,
    onSelectAddress,
  }), [graph, resolveENS, phase, onSelectAddress])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: Math.max(400, entry.contentRect.height),
        })
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const tree = useMemo(() => graphToTree(graph, resolveENS), [graph, resolveENS])

  const matchedAddresses = useMemo(
    () => (searchQuery ? filterTree(tree, searchQuery) : null),
    [tree, searchQuery],
  )

  const maxCommitted = useMemo(() => {
    let max = 0n
    for (const s of graph.summaries.values()) if (s.totalCommitted > max) max = s.totalCommitted
    return max
  }, [graph.summaries])

  const sizeScale = useMemo(
    () => d3Scale.scaleSqrt().domain([0, Number(maxCommitted) || 1]).range([4, 24]),
    [maxCommitted],
  )

  const handleBadgeClick = useCallback((address: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address); else next.add(address)
      return next
    })
  }, [])

  const handleSubtreeToggle = useCallback((nodeId: string) => {
    setCollapsedSubtrees((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
      return next
    })
  }, [])

  const { nodes: flowNodes, edges: flowEdges } = useMemo(() => {
    const outNodes: Node[] = []
    const outEdges: Edge[] = []

    if (tree.children.length === 0) {
      outNodes.push({
        id: 'armada',
        type: 'root',
        position: { x: dimensions.width / 2 - NODE_HALF, y: 20 - NODE_HALF },
        data: { label: 'Armada' } satisfies RootNodeData,
        draggable: false, selectable: false,
      })
      return { nodes: outNodes, edges: outEdges }
    }

    const root = d3Hierarchy.hierarchy(tree, (d) => (collapsedSubtrees.has(d.id) ? [] : d.children))
    // nodeSize over size: give each leaf fixed vertical room, let the tree grow as tall as needed.
    const VERTICAL_SPACING = 40
    const layout = d3Hierarchy
      .tree<TreeNode>()
      .nodeSize([VERTICAL_SPACING, 0])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.5))
    layout(root)

    // Shift signed, root-centred y-coords so the topmost node lands just below the hop labels.
    let minLayoutX = Infinity
    root.each((d) => { if ((d.x ?? 0) < minLayoutX) minLayoutX = d.x ?? 0 })
    const yOffset = 40 - minLayoutX

    root.each((d) => {
      const hopX = 80 + ((d.data.hop + 1) / 3) * (dimensions.width - 160)
      const centerY = (d.x ?? 0) + yOffset
      const isRoot = d.data.id === 'armada'
      outNodes.push({
        id: d.data.id,
        type: isRoot ? 'root' : 'participant',
        position: { x: hopX - NODE_HALF, y: centerY - NODE_HALF },
        data: isRoot
          ? ({ label: 'Armada' } satisfies RootNodeData)
          : ({
              address: d.data.address, label: d.data.label,
              hop: d.data.hop, hops: d.data.hops,
              isMultiHop: d.data.isMultiHop,
              committed: d.data.committed, perHop: d.data.perHop,
              radius: sizeScale(Number(d.data.committed)),
              isSelected: false, isConnected: false,
              isSearchMatch: true, searchActive: false,
              isExpanded: false, isCollapsed: false,
              childCount: d.data.children.length,
              onBadgeClick: handleBadgeClick,
              onSubtreeToggle: handleSubtreeToggle,
              nodeId: d.data.id,
            } satisfies ParticipantNodeData),
        draggable: false,
      })

      if (d.parent) {
        const parentId = d.parent.data.id
        const childId = d.data.id
        outEdges.push({
          id: `e-${parentId}->${childId}`,
          source: parentId,
          target: childId,
          type: 'invite',
          data: {
            fromHop: d.parent.data.hop,
            toHop: d.data.hop,
            isSelfInvite: d.parent.data.address === d.data.address,
            isInviterChain: false,
            dimmed: false,
          } satisfies InviteEdgeData,
        })
      }
    })

    return { nodes: outNodes, edges: outEdges }
  }, [tree, dimensions, collapsedSubtrees, sizeScale, handleBadgeClick, handleSubtreeToggle])

  const inviterChainKeys = useMemo(() => {
    const set = new Set<string>()
    if (!connectedAddress) return set
    const connAddr = connectedAddress.toLowerCase()
    const parentOfAddr = new Map<string, string>()
    for (const e of flowEdges) {
      const data = e.data as InviteEdgeData
      if (!data.isSelfInvite) parentOfAddr.set(e.target, e.source)
    }
    let current = connAddr
    while (current && current !== 'armada') {
      const parent = parentOfAddr.get(current)
      if (!parent) break
      set.add(`e-${parent}->${current}`)
      current = parent
    }
    return set
  }, [connectedAddress, flowEdges])

  const renderedNodes = useMemo<Node[]>(() => {
    return flowNodes.map((n) => {
      if (n.type === 'root') return n
      const base = n.data as ParticipantNodeData
      const isSelected = selectedAddress === base.address
      const isConnected = !!connectedAddress && base.address === connectedAddress.toLowerCase()
      const isSearchMatch = matchedAddresses === null || matchedAddresses.has(base.address)
      return {
        ...n,
        data: {
          ...base,
          isSelected,
          isConnected,
          isSearchMatch,
          searchActive: matchedAddresses !== null,
          isExpanded: expanded.has(base.address),
          isCollapsed: collapsedSubtrees.has(base.nodeId),
        } satisfies ParticipantNodeData,
      }
    })
  }, [flowNodes, selectedAddress, connectedAddress, matchedAddresses, expanded, collapsedSubtrees])

  const renderedEdges = useMemo<Edge[]>(() => {
    return flowEdges.map((e) => {
      const base = e.data as InviteEdgeData
      const sourceMatched = matchedAddresses === null || matchedAddresses.has(e.source)
      const targetMatched = matchedAddresses === null || matchedAddresses.has(e.target)
      const dimmed = matchedAddresses !== null && !sourceMatched && !targetMatched
      return {
        ...e,
        data: {
          ...base,
          isInviterChain: inviterChainKeys.has(e.id),
          dimmed,
        } satisfies InviteEdgeData,
      }
    })
  }, [flowEdges, matchedAddresses, inviterChainKeys])

  const handleNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      if (node.type === 'root') return
      const data = node.data as ParticipantNodeData
      onSelectAddress(selectedAddress === data.address ? null : data.address)
    },
    [onSelectAddress, selectedAddress],
  )

  const handleNodeMouseEnter = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      if (node.type === 'root') return
      const data = node.data as ParticipantNodeData
      onHoverAddress?.(data.address)
    },
    [onHoverAddress],
  )

  const handleNodeMouseLeave = useCallback(() => {
    onHoverAddress?.(null)
  }, [onHoverAddress])

  const handlePaneClick = useCallback(() => {
    onSelectAddress(null)
  }, [onSelectAddress])

  useEffect(() => {
    if (flowNodes.length > 0) {
      const t = setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 50)
      return () => clearTimeout(t)
    }
  }, [flowNodes.length, rf])

  // Auto zoom-to-search: when the search narrows to exactly one participant
  // match (plus root), jump the viewport to it. Tracks the last-zoomed match
  // in a ref so we don't re-fire on every unrelated re-render.
  const searchMatchAddress = useMemo(() => {
    if (!matchedAddresses) return null
    const participants = [...matchedAddresses].filter((a) => a !== 'armada')
    return participants.length === 1 ? participants[0] ?? null : null
  }, [matchedAddresses])
  const lastZoomedSearchRef = React.useRef<string | null>(null)
  useEffect(() => {
    if (!searchMatchAddress || searchMatchAddress === lastZoomedSearchRef.current) return
    lastZoomedSearchRef.current = searchMatchAddress
    rf.fitView({ nodes: [{ id: searchMatchAddress }], padding: 0.5, duration: 300, maxZoom: 1.5 })
  }, [searchMatchAddress, rf])
  // Reset the ref when the search is cleared so a later single-match re-zooms.
  useEffect(() => {
    if (!searchMatchAddress) lastZoomedSearchRef.current = null
  }, [searchMatchAddress])

  // Zoom-to-connected — only enabled when the connected wallet has a node in the graph.
  const connectedHasNode = useMemo(() => {
    if (!connectedAddress) return false
    const lower = connectedAddress.toLowerCase()
    return flowNodes.some((n) => n.id === lower)
  }, [connectedAddress, flowNodes])
  const handleZoomToConnected = useCallback(() => {
    if (!connectedAddress) return
    rf.fitView({
      nodes: [{ id: connectedAddress.toLowerCase() }],
      padding: 0.5,
      duration: 300,
      maxZoom: 1.5,
    })
  }, [connectedAddress, rf])

  if (props.isLoading && graph.nodes.size === 0) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-6 min-h-[400px] flex items-center justify-center"
      >
        <div className="size-24 rounded-full bg-muted animate-pulse" />
      </div>
    )
  }

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
    <div ref={containerRef} className="rounded-lg border border-border bg-card relative min-h-[400px]" style={{ height: dimensions.height }}>
      <div className="absolute top-2 left-0 right-0 flex justify-around text-xs text-muted-foreground z-10 pointer-events-none">
        <span>Root</span>
        <span>Seed (hop-0)</span>
        <span>Hop-1</span>
        <span>Hop-2</span>
      </div>

      <GraphLegend connectedAddress={connectedAddress} />

      <TreeViewContext.Provider value={ctxValue}>
        <ReactFlow
          nodes={renderedNodes}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={handleNodeClick}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          onPaneClick={handlePaneClick}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.1}
          maxZoom={4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Controls showInteractive={false} />
          {(connectedHasNode || searchMatchAddress) && (
            <Panel position="bottom-right" className="flex flex-col gap-1">
              {connectedHasNode && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 shadow-sm bg-card/80 backdrop-blur-sm"
                  onClick={handleZoomToConnected}
                  aria-label="Jump to your wallet"
                >
                  <Crosshair className="size-3.5" />
                  My wallet
                </Button>
              )}
              {searchMatchAddress && (
                <span className="text-[10px] text-muted-foreground rounded-md border border-border bg-card/80 backdrop-blur-sm px-2 py-1 flex items-center gap-1 shadow-sm">
                  <Search className="size-3" /> auto-zoomed to match
                </span>
              )}
            </Panel>
          )}
        </ReactFlow>
      </TreeViewContext.Provider>
    </div>
  )
}

export function TreeView(props: TreeViewProps) {
  return (
    <ReactFlowProvider>
      <TreeViewInner {...props} />
    </ReactFlowProvider>
  )
}

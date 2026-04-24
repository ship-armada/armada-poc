// ABOUTME: Radial, force-directed DAG view of the crowdfund invite tree using d3-force + SVG.
// ABOUTME: Spike replacement for the xyflow-based TreeView — layout is D3, render is React/SVG.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceRadial,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'
import { select } from 'd3-selection'
import {
  zoom as d3Zoom,
  zoomIdentity,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3-zoom'
import { Maximize2, Minus, Plus } from 'lucide-react'

import type { CrowdfundGraph } from '../lib/graph.js'
import { buildRadialGraph, type RadialNode } from '../lib/radialLayout.js'
import { formatUsdc, truncateAddress } from '../lib/format.js'
import { GraphLegend } from './GraphLegend.js'
import { Button } from './ui/button.js'

// ──────────────────────────────────────────────────────────────────────────────
// Deferred items (see ../../SPIKE_DEFERRED.md):
//   - multi-hop pie-slice nodes
//   - identicons on node faces
//   - hover cards / click popover (NodeDetail)
//   - search-query filtering + auto-zoom
//   - subtree collapse, multi-hop badge expansion
//   - "My wallet" zoom-to-connected button
//   - inviter-chain edge highlighting
//   - edge gradients / animation
// ──────────────────────────────────────────────────────────────────────────────

export interface RadialTreeViewProps {
  graph: CrowdfundGraph
  selectedAddress: string | null
  onSelectAddress: (addr: string | null) => void
  onHoverAddress?: (addr: string | null) => void
  /** Accepted for API parity with TreeView; not yet wired in the spike. */
  onViewInTable?: (addr: string) => void
  /** Accepted for API parity with TreeView; search not yet wired in the spike. */
  searchQuery: string
  phase: number
  resolveENS: (addr: string) => string | null
  connectedAddress?: string | null
  isLoading?: boolean
}

type SimNode = RadialNode & SimulationNodeDatum
type SimEdge = SimulationLinkDatum<SimNode> & { id: string }

/** Padding from the container edge to the outer-most hop ring, in px.
 *  Must accommodate the outer-ring node radius (hop-2, r=4) + stroke + some
 *  force overshoot. Deliberately smaller than earlier revisions now that
 *  outer nodes have shrunk — more radius means more breathing room on every
 *  ring without changing the band ratios. */
const OUTER_PADDING = 30

/** The radius of the outer-most ring for a given viewport. */
function computeMaxR(width: number, height: number): number {
  return Math.max(80, Math.min(width, height) / 2 - OUTER_PADDING)
}

/** Compute the ring radius for a given hop, scaled to the viewport. */
function hopRadius(hop: number, maxR: number): number {
  if (hop < 0) return 0 // root at center
  // Hops 0..2 spread from centre to the outer ring.
  const bands = [0.3, 0.65, 1.0]
  return bands[Math.min(hop, bands.length - 1)]! * maxR
}

function hopColorVar(hop: number): string {
  // Root uses hop-0 teal rather than `--hop-root` grey — matches the mockup
  // where the Armada centre sits visually inside the seed colour family.
  if (hop < 0) return 'var(--hop-0)'
  if (hop === 0) return 'var(--hop-0)'
  if (hop === 1) return 'var(--hop-1)'
  return 'var(--hop-2)'
}

/** Source-side colour for an edge gradient. Root edges blend teal→teal. */
function edgeSourceColor(sourceHop: number): string {
  return hopColorVar(sourceHop < 0 ? 0 : sourceHop)
}

/** Node radius by hop. Matches the design mockup's visual hierarchy —
 *  Armada center dominates, seeds prominent, hops 1/2 recede. Drives both the
 *  rendered `<circle>` and the `forceCollide` radius so spacing matches size. */
function nodeRadius(hop: number): number {
  if (hop < 0) return 28 // Armada root — clearly largest, also pulses
  if (hop === 0) return 18
  if (hop === 1) return 9
  if (hop === 2) return 4
  return 4
}

export function RadialTreeView(props: RadialTreeViewProps) {
  const { graph, selectedAddress, onSelectAddress, onHoverAddress, connectedAddress } = props

  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // `null` until we've measured the container. Rendering the SVG before we
  // know real dimensions causes a visible "shrink" on first paint as the
  // simulation re-seeds with the correct maxR once ResizeObserver fires.
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)

  // Keep sim nodes keyed by id so new graph updates preserve x/y (no jarring jumps).
  const nodeMapRef = useRef<Map<string, SimNode>>(new Map())
  const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null)

  // The rendered snapshot (updated every tick). We store the SimNode array directly
  // since d3 mutates positions in place — the new array reference triggers React rerender.
  const [nodes, setNodes] = useState<SimNode[]>([])
  const [edges, setEdges] = useState<SimEdge[]>([])

  // d3-zoom in React-controlled mode: d3 captures wheel/drag events, React renders
  // the transform on the outer <g>. zoomIdentity = { k: 1, x: 0, y: 0 }.
  const [zoomTransform, setZoomTransform] = useState<ZoomTransform>(zoomIdentity)
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  // Distinguishes a pan-end mouseup from a genuine pane click so pan interactions
  // don't wipe the current selection.
  const draggedRef = useRef(false)

  // Local hover state drives in-component dimming. Separate from the parent's
  // hoveredAddress (cross-view sync via `onHoverAddress` prop) — which keeps
  // the dimming responsive regardless of how slow the parent atom rerenders.
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const connectedLower = connectedAddress?.toLowerCase() ?? null

  // Measure the container synchronously before the first paint so the first
  // simulation cycle already uses the real viewport — no "shrink" on load.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setDimensions({
      width: rect.width,
      height: Math.max(600, rect.height),
    })
  }, [])

  // Observe subsequent container resizes.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: Math.max(600, entry.contentRect.height),
        })
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Attach d3-zoom to the SVG. React owns the transform — we just stash the
  // behavior ref so the control buttons (below) can call its helpers.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        setZoomTransform(event.transform)
        // Any non-wheel source event means the user is dragging to pan.
        if (event.sourceEvent && event.sourceEvent.type !== 'wheel') {
          draggedRef.current = true
        }
      })
      .on('end', () => {
        // Defer clearing so the ensuing click handler can still read `true`.
        setTimeout(() => {
          draggedRef.current = false
        }, 0)
      })
    select(svg).call(behavior)
    zoomBehaviorRef.current = behavior
    return () => {
      select(svg).on('.zoom', null)
      zoomBehaviorRef.current = null
    }
  }, [])

  const handleZoomIn = useCallback(() => {
    const svg = svgRef.current
    const zb = zoomBehaviorRef.current
    if (!svg || !zb) return
    select(svg).transition().duration(200).call(zb.scaleBy, 1.3)
  }, [])

  const handleZoomOut = useCallback(() => {
    const svg = svgRef.current
    const zb = zoomBehaviorRef.current
    if (!svg || !zb) return
    select(svg).transition().duration(200).call(zb.scaleBy, 1 / 1.3)
  }, [])

  const handleFitView = useCallback(() => {
    const svg = svgRef.current
    const zb = zoomBehaviorRef.current
    if (!svg || !zb || !dimensions || nodes.length === 0) return
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    if (!Number.isFinite(minX)) return
    const pad = 40
    const bboxW = Math.max(1, maxX - minX)
    const bboxH = Math.max(1, maxY - minY)
    const scale = Math.min(
      (dimensions.width - 2 * pad) / bboxW,
      (dimensions.height - 2 * pad) / bboxH,
      4,
    )
    const bboxCx = (minX + maxX) / 2
    const bboxCy = (minY + maxY) / 2
    // Combined render transform is `zoom × translate(cx, cy) × sim`, so to land
    // the bbox centre at the viewport centre we solve k*(bboxC + cVp) + t = cVp.
    const cxVp = dimensions.width / 2
    const cyVp = dimensions.height / 2
    const tx = cxVp * (1 - scale) - scale * bboxCx
    const ty = cyVp * (1 - scale) - scale * bboxCy
    const target = zoomIdentity.translate(tx, ty).scale(scale)
    select(svg).transition().duration(300).call(zb.transform, target)
  }, [dimensions, nodes])

  const handlePaneClick = useCallback(() => {
    if (draggedRef.current) return
    onSelectAddress(null)
  }, [onSelectAddress])

  // Build the target graph whenever source data changes.
  // Note: `resolveENS` is deliberately NOT a dep — the adapter doesn't use it.
  // This keeps `target` stable across selection/hover rerenders so the
  // simulation doesn't restart and jiggle every node on click.
  const target = useMemo(() => buildRadialGraph(graph), [graph])

  // Lineage helpers for hover dimming — parent + children adjacency from the
  // tree edges. O(V + E) to build, reused for every hover event.
  const { parentOf, childrenOf } = useMemo(() => {
    const pOf = new Map<string, string>()
    const cOf = new Map<string, string[]>()
    for (const e of target.edges) {
      pOf.set(e.target, e.source)
      const arr = cOf.get(e.source) ?? []
      arr.push(e.target)
      cOf.set(e.source, arr)
    }
    return { parentOf: pOf, childrenOf: cOf }
  }, [target])

  // Lineage highlight: driven by hover when active, else by the persistent
  // selection. Lets the user pin a subtree via click, then preview other
  // subtrees via hover without losing their selection context.
  const highlightSourceId = hoveredId ?? selectedAddress ?? null

  // Nodes + edges to keep at full opacity: the active node (hovered or
  // selected), its ancestor chain to Armada, and its full descendant
  // subtree. Armada itself is always in the set (shared ancestor of all).
  const highlight = useMemo(() => {
    if (!highlightSourceId) return null
    const nodesSet = new Set<string>(['armada', highlightSourceId])
    const edgesSet = new Set<string>()
    let current = highlightSourceId
    while (parentOf.has(current)) {
      const p = parentOf.get(current)!
      edgesSet.add(`${p}->${current}`)
      nodesSet.add(p)
      current = p
    }
    const queue = [highlightSourceId]
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const child of childrenOf.get(id) ?? []) {
        if (nodesSet.has(child)) continue
        nodesSet.add(child)
        edgesSet.add(`${id}->${child}`)
        queue.push(child)
      }
    }
    return { nodes: nodesSet, edges: edgesSet }
  }, [highlightSourceId, parentOf, childrenOf])

  // Simulation lifecycle: create once, stop on unmount.
  useEffect(() => {
    const sim = forceSimulation<SimNode, SimEdge>()
      .alphaDecay(0.06)
      .velocityDecay(0.35)
      .on('tick', () => {
        // Replace arrays so React rerenders. d3 mutates the node/edge objects in place.
        const nodeArr = sim.nodes().slice()
        const edgeArr = (sim.force('link') as ReturnType<typeof forceLink<SimNode, SimEdge>> | null)
          ?.links()
          .slice() ?? []
        setNodes(nodeArr)
        setEdges(edgeArr as SimEdge[])
      })
    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [])

  // Sync target nodes/edges into the simulation whenever the graph or viewport changes.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    if (!dimensions) return

    const prev = nodeMapRef.current
    const next = new Map<string, SimNode>()

    // Merge: keep x/y from previous run; new nodes are seeded from their parent's position
    // so they animate outward instead of popping in at the origin.
    for (const n of target.nodes) {
      const existing = prev.get(n.id)
      if (existing) {
        // Update data fields in place; preserve x/y/vx/vy.
        existing.address = n.address
        existing.label = n.label
        existing.hop = n.hop
        existing.hops = n.hops
        existing.isMultiHop = n.isMultiHop
        existing.committed = n.committed
        existing.parentId = n.parentId
        next.set(n.id, existing)
      } else {
        const seed: SimNode = { ...n }
        const parentSim = n.parentId ? prev.get(n.parentId) ?? next.get(n.parentId) : null
        if (parentSim && typeof parentSim.x === 'number' && typeof parentSim.y === 'number') {
          seed.x = parentSim.x + (Math.random() - 0.5) * 4
          seed.y = parentSim.y + (Math.random() - 0.5) * 4
        } else {
          // Armada root or orphan — start near center.
          seed.x = 0
          seed.y = 0
        }
        next.set(n.id, seed)
      }
    }

    // Pin the Armada root at the origin.
    const armada = next.get('armada')
    if (armada) {
      armada.fx = 0
      armada.fy = 0
    }

    nodeMapRef.current = next
    const nodeArr = [...next.values()]

    // Build edges referencing the live sim node objects.
    const edgeArr: SimEdge[] = target.edges.map((e) => ({
      id: e.id,
      source: next.get(e.source) ?? e.source,
      target: next.get(e.target) ?? e.target,
    }))

    const maxR = computeMaxR(dimensions.width, dimensions.height)

    sim
      .nodes(nodeArr)
      // Stronger link force pulls siblings angularly toward their parent so
      // each subtree forms a visible branch on its ring, not a scattered arc.
      .force(
        'link',
        forceLink<SimNode, SimEdge>(edgeArr)
          .id((d) => d.id)
          .distance(60)
          .strength(0.5),
      )
      // Weak charge — radial force should dominate. With -80 nodes bounced off
      // their rings; at -35 they settle and the ring structure is legible.
      .force('charge', forceManyBody<SimNode>().strength(-35).distanceMax(maxR))
      .force(
        'radial',
        forceRadial<SimNode>((d) => hopRadius(d.hop, maxR)).strength(0.9),
      )
      // Collision buffer varies by hop: inner rings (root, hop-0, hop-1)
      // get +4 for generous spacing. Hop-2 keeps +2 — any larger and the
      // ~240-node outer ring at stress300 overflows its circumference and
      // gets pushed off-ring into the "spiky" shape.
      .force(
        'collide',
        forceCollide<SimNode>().radius(
          (d) => nodeRadius(d.hop) + (d.hop < 2 ? 4 : 2),
        ),
      )
      .alpha(0.6)
      .restart()
  }, [target, dimensions])

  // Empty / loading states — match TreeView's container styling.
  if (props.isLoading && graph.nodes.size === 0) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-6 min-h-[600px] flex items-center justify-center"
      >
        <div className="size-24 rounded-full bg-muted animate-pulse" />
      </div>
    )
  }

  if (graph.nodes.size === 0) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-6 text-center min-h-[600px] flex flex-col items-center justify-center"
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

  // Hold the container mount until we've measured it — this is what
  // useLayoutEffect is hooking into. Must come AFTER the loading/empty early
  // returns so their container refs get a chance to mount first.
  if (!dimensions) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card min-h-[600px]"
      />
    )
  }

  // Render: SVG with a centered group; edges below nodes.
  const cx = dimensions.width / 2
  const cy = dimensions.height / 2

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-border relative min-h-[600px] overflow-hidden"
      style={{
        height: dimensions.height,
        // Radial gradient background — lighter centre, darker rim. Acts as
        // both a depth cue and a viewport vignette that stays anchored to
        // the screen centre as the user pans. Hex values chosen to be
        // theme-adjacent; if promoted, move to `--rtv-bg-{inner,outer}` tokens.
        background:
          'radial-gradient(circle at center, #0F172A 0%, #020617 100%)',
      }}
    >
      <GraphLegend connectedAddress={connectedAddress} />
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onClick={handlePaneClick}
        style={{ cursor: 'grab' }}
      >
        <defs>
          {/* Spike-scoped stylesheet — keyframes + edge-flow animation.
              Dash period (4+6=10px) matches the dashoffset animation target
              (-10), giving a seamless loop. Honours prefers-reduced-motion. */}
          <style>{`
            .rtv-edge {
              stroke-dasharray: 4 6;
              animation: rtv-edge-flow 3s linear infinite;
            }
            @keyframes rtv-edge-flow {
              to { stroke-dashoffset: -10; }
            }
            /* Root-circle pulse. Scale only the outer circle so the inner
               dark core + "Armada" text stay still — otherwise the label
               appears to glitch. transform-box: fill-box pins the origin
               to the circle's fill centre. */
            .rtv-root-pulse {
              transform-box: fill-box;
              transform-origin: center;
              animation: rtv-root-pulse 3s ease-in-out infinite;
            }
            @keyframes rtv-root-pulse {
              0%, 100% { transform: scale(1); }
              50%      { transform: scale(1.04); }
            }
            @media (prefers-reduced-motion: reduce) {
              .rtv-edge {
                animation: none;
                stroke-dasharray: none;
              }
              .rtv-root-pulse { animation: none; }
            }
          `}</style>
          {/* Glow filters — applied selectively to root + hop-0 only (per
              mockup). Padded filter region prevents the blur from being
              clipped at the element's tight default bounding box. */}
          <filter
            id="rtv-glow-strong"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="6" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter
            id="rtv-glow-medium"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter
            id="rtv-glow-soft"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="1.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Per-edge gradients — one per edge because `userSpaceOnUse`
              needs endpoint coords to run from source to target regardless
              of edge orientation. With shared gradients the direction would
              flip for edges at different angles. */}
          {edges.map((e) => {
            const s = typeof e.source === 'object' ? (e.source as SimNode) : null
            const t = typeof e.target === 'object' ? (e.target as SimNode) : null
            if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null
            return (
              <linearGradient
                key={`grad-${e.id}`}
                id={`rtv-edge-grad-${e.id}`}
                gradientUnits="userSpaceOnUse"
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
              >
                <stop offset="0%" stopColor={edgeSourceColor(s.hop)} />
                <stop offset="100%" stopColor={hopColorVar(t.hop)} />
              </linearGradient>
            )
          })}
        </defs>
        <g
          transform={`translate(${zoomTransform.x}, ${zoomTransform.y}) scale(${zoomTransform.k})`}
        >
          <g transform={`translate(${cx}, ${cy})`}>
          {/* Hop rings — faint guide circles. */}
          {[0, 1, 2].map((h) => (
            <circle
              key={`ring-${h}`}
              cx={0}
              cy={0}
              r={hopRadius(h, computeMaxR(dimensions.width, dimensions.height))}
              fill="none"
              stroke="var(--border)"
              strokeDasharray="2 4"
              strokeOpacity={0.35}
            />
          ))}

          {/* Edges. Quadratic Bezier curves bowing toward the Armada centre.
              Control point = midpoint × 0.7 — pulls the curve 30% closer to
              the origin. Root→child edges stay straight (their midpoint is
              already on the origin-line, so pulling keeps it on the line).
              Hop-2 edges are ~75% of total at stress300, rendered at lower
              opacity so they sit behind hop-1 edges visually. */}
          <g>
            {edges.map((e) => {
              const s = typeof e.source === 'object' ? (e.source as SimNode) : null
              const t = typeof e.target === 'object' ? (e.target as SimNode) : null
              if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null
              const mx = (s.x + t.x) / 2
              const my = (s.y + t.y) / 2
              const cx = mx * 0.7
              const cy = my * 0.7
              const baseOpacity = t.hop === 2 ? 0.06 : 0.15
              // During hover: lineage edges brighten, non-lineage edges fade.
              // Idle state: just the base (hop-stratified) opacity.
              const opacity = !highlight
                ? baseOpacity
                : highlight.edges.has(e.id)
                  ? 0.5
                  : 0.03
              return (
                <path
                  key={e.id}
                  className="rtv-edge"
                  d={`M ${s.x},${s.y} Q ${cx},${cy} ${t.x},${t.y}`}
                  fill="none"
                  stroke={`url(#rtv-edge-grad-${e.id})`}
                  strokeWidth={1}
                  strokeOpacity={opacity}
                  style={{ transition: 'stroke-opacity 150ms ease-out' }}
                />
              )
            })}
          </g>

          {/* Nodes. */}
          <g>
            {nodes.map((n) => {
              if (n.x == null || n.y == null) return null
              const isRoot = n.hop < 0
              const isSelected = !isRoot && selectedAddress === n.address
              const isConnected = !isRoot && !!connectedLower && n.address === connectedLower
              const r = nodeRadius(n.hop)
              const fill = hopColorVar(n.hop)
              const stroke = isSelected
                ? 'var(--hop-selected)'
                : isConnected
                  ? 'var(--hop-connected)'
                  : 'var(--card)'
              const strokeWidth = isSelected ? 2.5 : isConnected ? 2 : 1
              // Glow stratified by hop: strong on root, medium on hop-0,
              // soft on hop-1, none on hop-2 (kept crisp — r=4 dots would
              // wash out under blur and we avoid ~240 filter evaluations
              // per tick on the outer ring).
              const glowFilter = isRoot
                ? 'url(#rtv-glow-strong)'
                : n.hop === 0
                  ? 'url(#rtv-glow-medium)'
                  : n.hop === 1
                    ? 'url(#rtv-glow-soft)'
                    : undefined

              // Dim non-lineage nodes during hover; keep full opacity otherwise.
              // Selected node stays fully opaque so selection context isn't lost
              // when hovering elsewhere.
              const nodeOpacity =
                !highlight || highlight.nodes.has(n.id) || isSelected ? 1 : 0.15

              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  style={{
                    cursor: isRoot ? 'default' : 'pointer',
                    opacity: nodeOpacity,
                    transition: 'opacity 150ms ease-out',
                  }}
                  onClick={(evt) => {
                    evt.stopPropagation()
                    if (isRoot) return
                    onSelectAddress(selectedAddress === n.address ? null : n.address)
                  }}
                  onMouseEnter={() => {
                    if (isRoot) return
                    setHoveredId(n.id)
                    onHoverAddress?.(n.address)
                  }}
                  onMouseLeave={() => {
                    if (isRoot) return
                    setHoveredId(null)
                    onHoverAddress?.(null)
                  }}
                >
                  <circle
                    r={r}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    filter={glowFilter}
                    className={isRoot ? 'rtv-root-pulse' : undefined}
                  />
                  {/* Root only: inner dark core turns the Armada circle into
                      a teal ring framing the centred label — matches the
                      mockup's ship-icon treatment. */}
                  {isRoot && (
                    <circle
                      r={r * 0.6}
                      fill="var(--card)"
                      pointerEvents="none"
                    />
                  )}
                  {n.isMultiHop && !isRoot && (
                    <circle
                      r={r + 3}
                      fill="none"
                      stroke="var(--hop-multi)"
                      strokeWidth={1.25}
                      strokeDasharray="2 2"
                      pointerEvents="none"
                    />
                  )}
                  {isRoot && (
                    <text
                      y={4}
                      textAnchor="middle"
                      className="fill-foreground text-[10px] font-semibold pointer-events-none"
                    >
                      Armada
                    </text>
                  )}
                </g>
              )
            })}
          </g>
          </g>
        </g>
      </svg>

      {/* Zoom controls — mirrors xyflow's <Controls /> affordances. */}
      <div className="absolute bottom-2 left-2 z-10 flex flex-col gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-7 bg-card/80 backdrop-blur-sm shadow-sm"
          onClick={handleZoomIn}
          aria-label="Zoom in"
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-7 bg-card/80 backdrop-blur-sm shadow-sm"
          onClick={handleZoomOut}
          aria-label="Zoom out"
        >
          <Minus className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-7 bg-card/80 backdrop-blur-sm shadow-sm"
          onClick={handleFitView}
          aria-label="Fit view"
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>

      {/* Hover tooltip — anchored to the node in screen space via the active
          zoom transform. Re-renders ride the existing tick / zoom / pan
          render cycles, so we don't need a mousemove handler. Skips root
          (its hover is a no-op) and nodes without positions. */}
      {(() => {
        const n = hoveredId ? nodeMapRef.current.get(hoveredId) : null
        if (!n || n.hop < 0 || n.x == null || n.y == null) return null
        const screenX = zoomTransform.k * (n.x + cx) + zoomTransform.x
        const screenY = zoomTransform.k * (n.y + cy) + zoomTransform.y
        const hopLine = n.isMultiHop
          ? `Hops ${n.hops.join(', ')}`
          : `Hop ${n.hop}`
        return (
          <div
            className="absolute pointer-events-none z-20 rounded-md border border-border bg-card shadow-md px-2 py-1.5 text-xs leading-tight min-w-[8rem]"
            style={{ left: screenX + 14, top: screenY - 10 }}
          >
            <div className="font-mono text-foreground">
              {truncateAddress(n.address)}
            </div>
            <div className="text-muted-foreground mt-0.5">
              {formatUsdc(n.committed)} committed
            </div>
            <div className="text-muted-foreground">{hopLine}</div>
          </div>
        )
      })()}
    </div>
  )
}

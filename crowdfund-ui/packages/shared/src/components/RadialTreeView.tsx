// ABOUTME: Radial, force-directed DAG view of the crowdfund invite tree using d3-force + SVG.
// ABOUTME: Spike replacement for the xyflow-based TreeView — layout is D3, render is React/SVG.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
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
import { Dot, Maximize2, Minus, Plus, ShipWheel, UserRound } from 'lucide-react'

import type { CrowdfundGraph } from '../lib/graph.js'
import {
  buildRadialGraph,
  computeAngleMap,
  type RadialNode,
} from '../lib/radialLayout.js'
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

type SimNode = RadialNode & SimulationNodeDatum & {
  /** Target angle (radians) for the sunburst-style angular force. Set by the
   *  sync effect from the current target graph; read by `forceAngular`. */
  angle?: number
}
type SimEdge = SimulationLinkDatum<SimNode> & { id: string }

/**
 * Custom d3-force that pulls each node toward its assigned angular sector
 * while letting radial/charge/collision forces handle distance and spacing.
 * Multiplying by current radius makes the convergence rate consistent across
 * rings (a 0.5 rad delta at r=250 and r=80 will take similar tick counts).
 * Skips root (pinned at origin) and pre-positioning nodes near the origin to
 * avoid noisy tangents.
 */
function forceAngular(strength: number) {
  let simNodes: SimNode[] = []

  function force(alpha: number) {
    for (const n of simNodes) {
      if (n.hop < 0) continue
      if (n.x == null || n.y == null || n.angle == null) continue
      const r = Math.sqrt(n.x * n.x + n.y * n.y)
      if (r < 1) continue

      const currentAngle = Math.atan2(n.y, n.x)
      let delta = n.angle - currentAngle
      // Normalize to [-π, π] so the pull always takes the shorter arc.
      while (delta > Math.PI) delta -= 2 * Math.PI
      while (delta < -Math.PI) delta += 2 * Math.PI

      const tangentX = -Math.sin(currentAngle)
      const tangentY = Math.cos(currentAngle)
      const push = strength * delta * r * alpha
      n.vx = (n.vx ?? 0) + tangentX * push
      n.vy = (n.vy ?? 0) + tangentY * push
    }
  }
  force.initialize = (nodes: SimNode[]) => {
    simNodes = nodes
  }
  return force
}

/** Replacement for d3-force's `forceRadial` that targets an ELLIPSE
 *  instead of a circle. For each node at current angle θ = atan2(y, x),
 *  the target distance from origin is `hopBand(hop) * ellipseR(θ)` where
 *  ellipseR(θ) = (rx·ry) / √((ry·cos θ)² + (rx·sin θ)²). Same force shape
 *  as forceRadial (radial pull scaled by strength × alpha / currentR),
 *  just with an angle-aware target radius. */
function forceEllipse(rx: number, ry: number, strength = 0.9) {
  let simNodes: SimNode[] = []
  function force(alpha: number) {
    for (const n of simNodes) {
      if (n.hop < 0) continue
      if (n.x == null || n.y == null) continue
      const curR = Math.sqrt(n.x * n.x + n.y * n.y)
      if (curR < 1e-3) continue
      const cosT = n.x / curR
      const sinT = n.y / curR
      const ellipseR =
        (rx * ry) / Math.sqrt((ry * cosT) ** 2 + (rx * sinT) ** 2)
      const targetR = hopBand(n.hop) * ellipseR
      const k = ((targetR - curR) * strength * alpha) / curR
      n.vx = (n.vx ?? 0) + n.x * k
      n.vy = (n.vy ?? 0) + n.y * k
    }
  }
  force.initialize = (nodes: SimNode[]) => {
    simNodes = nodes
  }
  return force
}

/** Padding from the container edge to the outer-most hop ring, in px.
 *  Must accommodate the outer-ring node radius (hop-2, r=3) + stroke + some
 *  force overshoot. Applied on both axes so the ellipse has equal padding. */
const OUTER_PADDING = 30

/** Cap on ellipse aspect ratio (rx/ry). Keeps wide viewports from producing
 *  an uncomfortably stretched graph; 1 would be perfectly circular. */
const MAX_ASPECT = 1.3

/** The outermost horizontal + vertical radii for a given viewport. Layout
 *  is elliptical — container is typically wider than tall, so rx > ry. rx
 *  is clamped to MAX_ASPECT × ry so very wide containers don't produce an
 *  exaggerated ellipse. */
function computeMaxRadii(
  width: number,
  height: number,
): { rx: number; ry: number } {
  const ry = Math.max(80, height / 2 - OUTER_PADDING)
  const rxNatural = Math.max(80, width / 2 - OUTER_PADDING)
  const rx = Math.min(rxNatural, ry * MAX_ASPECT)
  return { rx, ry }
}

/** Hop-to-band fraction of the outer radius. Same fraction applies to rx
 *  and ry — each ring is an ellipse with the same aspect ratio as the outer. */
function hopBand(hop: number): number {
  if (hop < 0) return 0 // root at center
  const bands = [0.3, 0.65, 1.0]
  return bands[Math.min(hop, bands.length - 1)]!
}

function hopColorVar(hop: number): string {
  // Four-colour scheme: teal root / purple hop-0 / orange hop-1 / fuchsia hop-2.
  if (hop < 0) return 'var(--hop-root)'
  if (hop === 0) return 'var(--hop-0)'
  if (hop === 1) return 'var(--hop-1)'
  return 'var(--hop-2)'
}

/** SVG elliptical arc path from (startAngle, endAngle) on the ellipse
 *  with semi-axes (rx, ry) centered at (cx, cy). Pass rx == ry for a
 *  circular arc. */
function describeArc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startAngle: number,
  endAngle: number,
): string {
  const startX = cx + Math.cos(startAngle) * rx
  const startY = cy + Math.sin(startAngle) * ry
  const endX = cx + Math.cos(endAngle) * rx
  const endY = cy + Math.sin(endAngle) * ry
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0
  return `M ${startX},${startY} A ${rx},${ry} 0 ${largeArcFlag},1 ${endX},${endY}`
}

/** Node radius by hop. Matches the design mockup's visual hierarchy —
 *  Armada center dominates, seeds prominent, hops 1/2 recede. Drives both the
 *  rendered `<circle>` and the `forceCollide` radius so spacing matches size. */
function nodeRadius(hop: number): number {
  if (hop < 0) return 45 // Armada root — dominant focal point per the mockup
  if (hop === 0) return 14
  if (hop === 1) return 7
  if (hop === 2) return 3
  return 3
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

  // Sunburst angle allocation — one source of truth for the sync effect
  // (assigns node.angle) and the render path (draws sector boundary arcs).
  //   gapFraction=0.22   — padding on each side of every parent wedge
  //   reservedAngle=0.35 — ~20° reserved at the top and bottom of the
  //                        vertical axis so ring labels aren't obscured
  //                        by nodes sitting near 90°/270°.
  const angleMap = useMemo(
    () => computeAngleMap(target.edges, 'armada', 0.22, 0.35),
    [target],
  )

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
    const { rx, ry } = computeMaxRadii(dimensions.width, dimensions.height)

    // Merge: keep x/y from previous run; new nodes are seeded along the line
    // from their parent toward their own target position (angle × ring-radius)
    // so the first tick's radial-force amplification points in the correct
    // direction. Seeding directly on top of the parent made new nodes fling
    // out along random jitter, then swing around the circle to their target.
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
        existing.angle = angleMap.get(n.id)?.angle
        next.set(n.id, existing)
      } else {
        const seed: SimNode = { ...n }
        seed.angle = angleMap.get(n.id)?.angle
        const info = angleMap.get(n.id)
        const parentSim = n.parentId ? prev.get(n.parentId) ?? next.get(n.parentId) : null
        if (info && parentSim && typeof parentSim.x === 'number' && typeof parentSim.y === 'number') {
          const frac = hopBand(n.hop)
          const targetX = Math.cos(info.angle) * frac * rx
          const targetY = Math.sin(info.angle) * frac * ry
          const t = 0.1 // seed 10% of the way from parent toward final target
          seed.x = parentSim.x + (targetX - parentSim.x) * t
          seed.y = parentSim.y + (targetY - parentSim.y) * t
        } else if (info) {
          // No parent position yet — seed on the target angle at a small radius.
          seed.x = Math.cos(info.angle) * 8
          seed.y = Math.sin(info.angle) * 8
        } else {
          // Armada root or orphan.
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
      // `distanceMax` uses the major axis so charge falls off before reaching
      // across the whole ellipse.
      .force('charge', forceManyBody<SimNode>().strength(-35).distanceMax(rx))
      .force('radial', forceEllipse(rx, ry, 0.9))
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
      // Sunburst angular force — pulls each node toward its assigned sector
      // midpoint so branches stay grouped on the outer rings. Strength 0.1
      // is gentle; raise toward 0.2–0.3 for tighter wedges, lower if layout
      // feels over-constrained.
      .force('angular', forceAngular(0.1))
      .alpha(0.6)
      .restart()
  }, [target, angleMap, dimensions])

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
        // Radial gradient background — lighter centre, darker rim. Depth
        // cue + viewport vignette. Hex values chosen to be theme-adjacent;
        // if promoted, move to `--rtv-bg-{inner,outer}` tokens.
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
            /* "Hot" edges — root→seed spokes get a faster pulse to draw
               the eye toward Armada. Reuses the same keyframes; only the
               duration changes. Higher opacity + stroke width are applied
               via SVG attributes per-edge (SVG attrs beat CSS rules). */
            .rtv-edge-hot {
              animation-duration: 2s;
            }
            /* Node entrance — pops new nodes from scale 0.3 to 1 with a
               quick fade. Applied to an inner wrapper g (NOT the outer
               positioning g) because CSS transform on an SVG element with
               an existing transform attribute replaces the attribute and
               would kill the translate. Animation runs once per DOM mount;
               existing nodes skip it across graph updates. */
            .rtv-node-enter {
              transform-origin: center;
              animation: rtv-node-pop 0.4s ease-out;
            }
            @keyframes rtv-node-pop {
              0%   { transform: scale(0.3); opacity: 0; }
              100% { transform: scale(1);   opacity: 1; }
            }
            @media (prefers-reduced-motion: reduce) {
              .rtv-edge {
                animation: none;
                stroke-dasharray: none;
              }
              .rtv-node-enter { animation: none; }
            }
          `}</style>
          {/* Glow filters — one per hop. Each stdDev is ~0.35 × the hop's
              node radius so the halo scales with node size and every ring
              reads as a "light source" of comparable relative intensity.
              Filter region is uniformly padded (-100%/300%) so there's
              plenty of headroom for the blur without clipping. Hop-2 has
              no glow (r=3 is too small — blur washes out the dot). */}
          <filter
            id="rtv-glow-root"
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feGaussianBlur stdDeviation="16" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter
            id="rtv-glow-hop0"
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feGaussianBlur stdDeviation="5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter
            id="rtv-glow-hop1"
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Procedural grayscale noise — breaks up the "flat digital"
              look without a PNG asset. feTurbulence generates fractal
              noise; feColorMatrix desaturates to grayscale so it doesn't
              tint the scene at low opacity. */}
          <filter id="rtv-noise" x="0" y="0" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.9"
              numOctaves={2}
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          {/* Viewport-fixed vignette. Centered at the SVG centre (not the
              content centre) so it stays put during pan. Transparent at
              the inner 60% so data-bearing rings aren't darkened; fades to
              the theme background colour at the corners, reinforcing focus
              on the Armada centre. */}
          <radialGradient
            id="rtv-vignette"
            gradientUnits="userSpaceOnUse"
            cx={dimensions.width / 2}
            cy={dimensions.height / 2}
            r={Math.sqrt(
              (dimensions.width / 2) ** 2 + (dimensions.height / 2) ** 2,
            )}
          >
            <stop offset="60%" stopColor="transparent" />
            <stop offset="100%" stopColor="var(--background)" />
          </radialGradient>
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
                <stop offset="0%" stopColor={hopColorVar(s.hop)} />
                <stop offset="100%" stopColor={hopColorVar(t.hop)} />
              </linearGradient>
            )
          })}
        </defs>
        <g
          transform={`translate(${zoomTransform.x}, ${zoomTransform.y}) scale(${zoomTransform.k})`}
        >
          <g transform={`translate(${cx}, ${cy})`}>
          {/* Hop orbital rings — neutral stroke (theme border) at low
              opacity so they read as structural guides rather than visual
              accents competing with node colours. Rendered as ellipses
              because layout is elliptical (rx > ry, wider than tall). */}
          {(() => {
            const { rx, ry } = computeMaxRadii(
              dimensions.width,
              dimensions.height,
            )
            return [0, 1, 2].map((h) => {
              const frac = hopBand(h)
              return (
                <ellipse
                  key={`ring-${h}`}
                  cx={0}
                  cy={0}
                  rx={frac * rx}
                  ry={frac * ry}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1}
                  strokeOpacity={0.2}
                />
              )
            })
          })()}

          {/* Hop labels — floating above each ring at the top (-y) so the
              structure is self-explanatory. Offset by 8px outward so the
              label doesn't collide with a node that happens to sit near 90°. */}
          {(() => {
            const { ry } = computeMaxRadii(dimensions.width, dimensions.height)
            return [0, 1, 2].map((h) => {
              // Label at the top of each ring's ellipse — y-axis, so use ry.
              const bandRy = hopBand(h) * ry
              return (
                <text
                  key={`ring-label-${h}`}
                  x={0}
                  y={-(bandRy + 8)}
                  textAnchor="middle"
                  fill={hopColorVar(h)}
                  fillOpacity={0.9}
                  className="text-[11px] font-semibold pointer-events-none select-none"
                >
                  {h === 0 ? 'Seed' : `Hop ${h}`}
                </text>
              )
            })
          })()}

          {/* Sector boundary arcs — one faint arc per seed's angular wedge,
              drawn just outside the hop-2 ring (in the OUTER_PADDING zone).
              Makes the sunburst wedge structure visible without crowding the
              data rings. Only seeds (hop === 0) get arcs; nested hop-1
              sectors would be too many and too short. */}
          {(() => {
            const { rx, ry } = computeMaxRadii(
              dimensions.width,
              dimensions.height,
            )
            const arcRx = rx + 15
            const arcRy = ry + 15
            return target.nodes
              .filter((n) => n.hop === 0)
              .map((seed) => {
                const info = angleMap.get(seed.id)
                if (!info) return null
                return (
                  <path
                    key={`sector-${seed.id}`}
                    d={describeArc(
                      0,
                      0,
                      arcRx,
                      arcRy,
                      info.angleMin,
                      info.angleMax,
                    )}
                    stroke="var(--border)"
                    strokeOpacity={0.2}
                    strokeWidth={1}
                    fill="none"
                  />
                )
              })
          })()}

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
              // Clip edge endpoints to the node boundaries so edges don't
              // visibly pass through the translucent interior of hollow
              // nodes. Shortening along the straight source→target vector
              // approximates the curve-tangent direction closely enough
              // that the visible curve change is imperceptible.
              const dx = t.x - s.x
              const dy = t.y - s.y
              const dist = Math.sqrt(dx * dx + dy * dy) || 1
              const sRadius = nodeRadius(s.hop)
              const tRadius = nodeRadius(t.hop)
              const sStartX = s.x + (dx / dist) * sRadius
              const sStartY = s.y + (dy / dist) * sRadius
              const tEndX = t.x - (dx / dist) * tRadius
              const tEndY = t.y - (dy / dist) * tRadius
              // Root→seed edges get a faster pulse + higher opacity + thicker
              // stroke — "energy pulse" radiating outward from Armada. Only 6
              // such edges at stress300, so it stays subtle.
              const isHot = s.hop < 0 && t.hop === 0
              const baseOpacity = isHot ? 0.45 : t.hop === 2 ? 0.08 : 0.18
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
                  className={isHot ? 'rtv-edge rtv-edge-hot' : 'rtv-edge'}
                  d={`M ${sStartX},${sStartY} Q ${cx},${cy} ${tEndX},${tEndY}`}
                  fill="none"
                  stroke={`url(#rtv-edge-grad-${e.id})`}
                  strokeWidth={isHot ? 2 : 1}
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
              // Root, hop-0, and hop-1 render as hollow rings — hop-coloured
              // stroke with a partially-transparent fill of the same colour.
              // Hop-2 stays solid (they're dots too small to benefit from a
              // ring treatment). Selected/connected stroke emphasis overrides
              // the default outline colour in both modes.
              const isHollow = n.hop < 2
              // Pre-blend the hop colour against the card background so the
              // main circle can render OPAQUE (covering the glow backing's
              // interior) while still LOOKING like a translucent fill.
              // Icons then sit on a known solid colour rather than seeing the
              // saturated backing bleed through.
              const fillPct =
                n.hop < 0 ? 5 : n.hop === 0 ? 15 : n.hop === 1 ? 25 : 100
              const fill =
                fillPct === 100
                  ? hopColorVar(n.hop)
                  : `color-mix(in oklch, ${hopColorVar(n.hop)} ${fillPct}%, var(--card) ${100 - fillPct}%)`
              const strokeBase = isHollow ? (n.hop < 0 ? 3 : 2) : 1
              const stroke = isSelected
                ? 'var(--hop-selected)'
                : isConnected
                  ? 'var(--hop-connected)'
                  : isHollow
                    ? hopColorVar(n.hop)
                    : 'var(--card)'
              const strokeWidth = isSelected
                ? strokeBase + 1
                : isConnected
                  ? strokeBase + 0.5
                  : strokeBase
              // Glow stratified by hop: strong on root, medium on hop-0,
              // soft on hop-1, none on hop-2 (kept crisp — r=4 dots would
              // wash out under blur and we avoid ~240 filter evaluations
              // per tick on the outer ring).
              const glowFilter = isRoot
                ? 'url(#rtv-glow-root)'
                : n.hop === 0
                  ? 'url(#rtv-glow-hop0)'
                  : n.hop === 1
                    ? 'url(#rtv-glow-hop1)'
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
                  <g className="rtv-node-enter">
                  {/* Glow backing (hollow nodes only): an opaque, full-
                      saturation copy of the node underneath the main
                      translucent one, so the Gaussian blur has a full-
                      intensity source to work with. Without this, the
                      translucent fill of a hollow node makes the glow
                      disappear. */}
                  {isHollow && glowFilter && (
                    <circle
                      r={r}
                      fill={hopColorVar(n.hop)}
                      filter={glowFilter}
                      pointerEvents="none"
                    />
                  )}
                  <circle
                    r={r}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    filter={isHollow ? undefined : glowFilter}
                  />
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
                  {/* Per-hop icons: root (ship placeholder — to be replaced
                      with logo), hop-0 (user), hop-1 (circle). Hop-2 is too
                      small for legible iconography. Each icon is wrapped
                      in a <g> translated by -size/2 so its natural
                      top-left origin lands centered at the node's (0, 0).
                      Colours match the hop's outline colour — against the
                      translucent same-colour fill, the full-intensity icon
                      reads as a brighter mark inside the node. */}
                  {isRoot && (
                    <g transform="translate(-20, -20)" pointerEvents="none">
                      <ShipWheel size={40} color="var(--hop-root-icon)" strokeWidth={1.75} />
                    </g>
                  )}
                  {n.hop === 0 && (
                    <g transform="translate(-8, -8)" pointerEvents="none">
                      <UserRound size={16} color="var(--hop-0-icon)" strokeWidth={2} />
                    </g>
                  )}
                  {/* Lucide Dot is a tiny centred circle inside a 24-viewBox;
                      size 24 gives us a visible solid dot at the node centre
                      without enlarging the glyph beyond readability. */}
                  {n.hop === 1 && (
                    <g transform="translate(-12, -12)" pointerEvents="none">
                      <Dot size={24} color="var(--hop-1-icon)" strokeWidth={2} />
                    </g>
                  )}
                  </g>
                </g>
              )
            })}
          </g>
          </g>
        </g>

        {/* Vignette overlay — sibling to the zoom group so it stays
            viewport-fixed, rendered last so it composites on top of all
            content. pointerEvents:none so clicks pass through to the
            pane/nodes beneath. */}
        <rect
          x={0}
          y={0}
          width={dimensions.width}
          height={dimensions.height}
          fill="url(#rtv-vignette)"
          pointerEvents="none"
        />
        {/* Noise grain overlay — rendered after vignette so the grain
            appears uniform across the composite, including the darkened
            corners. Opacity kept very low; even 0.04 adds perceptible
            texture without muddying the content. */}
        <rect
          x={0}
          y={0}
          width={dimensions.width}
          height={dimensions.height}
          filter="url(#rtv-noise)"
          opacity={0.06}
          pointerEvents="none"
        />
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

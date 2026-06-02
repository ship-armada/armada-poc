// ABOUTME: Three.js sphere rendering of the Armada invite tree — wallets, hop layers, real invite edges, lineage highlighting on selection, multi-hop halos.
// ABOUTME: Ported from the armada-crowdfund mockup's iskay/realistic-crowdfund-mock branch (commit 11e4995); '/armada-symbol.svg' public-folder path replaced with an ESM asset import.

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import armadaSymbolUrl from '../../assets/armada-symbol.svg'
import { GRAPH_HOP_NODE_COLORS } from '../../lib/graphHopColors.js'

type NodeKind = 'Hop 0' | 'Hop 1' | 'Hop 2' | 'Multi-hop' | 'Your wallet'

type HoverState = {
  visible: boolean
  x: number
  y: number
  kind: NodeKind
  address: string
  committed: string
}

type NodeMeta = { kind: NodeKind; address: string; committed: string; ghost?: boolean; multiHop?: boolean; inviters?: string[] }

export type PinnedNode = {
  kind: NodeKind
  address: string
  committed?: string
  multiHop?: boolean
  /** Every distinct inviter of this wallet. NodeSphere emits one edge per
   *  entry so a multi-hop wallet shows every incoming invite relationship.
   *  Use the `'armada'` / `'Armada'` sentinel to anchor an edge at the
   *  center sprite (see {@link isArmadaSentinel}). */
  inviters?: string[]
}

// Feature flag for the hover-on-node tooltip. Flipping this back to false
// disables the floating tooltip that follows the cursor over selectable
// nodes (the pinned selected-node tip below is independent and stays).
const SHOW_HOVER_POPUP = true

const COLORS: Record<NodeKind, number> = GRAPH_HOP_NODE_COLORS

// The "Armada" root inviter is represented as a sentinel string in pinned-node
// `inviter` fields. Two upstream conventions in the wild:
//   - `mockParticipants` emits `'Armada'` (capital A).
//   - `graph.ts` / `toDashboardParticipantsFromGraph` (live data) returns
//     `'armada'` (lowercase, from `ROOT_ADDRESS`).
// Any real address starts with `0x` so a case-insensitive compare is a safe
// disambiguator. Centralized here so the 5 sentinel-check sites below stay in
// lockstep regardless of which data source we're rendering.
const isArmadaSentinel = (s: string | null | undefined): boolean =>
  !!s && s.toLowerCase() === 'armada'

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeAddress(rand: () => number) {
  const hex = '0123456789abcdef'
  const pick = () => hex[Math.floor(rand() * hex.length)]
  let out = '0x'
  for (let i = 0; i < 40; i += 1) out += pick()
  return `${out.slice(0, 6)}...${out.slice(-4)}`
}

function makeCommitted(rand: () => number) {
  const v = Math.floor(rand() * 2500) // $0..$2499
  return `$${v.toLocaleString()} committed`
}

function randomUnitVector(rand: () => number) {
  // Uniform unit vector
  const u = rand()
  const v = rand()
  const theta = 2 * Math.PI * u
  const phi = Math.acos(2 * v - 1)
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  )
}

// Return a unit vector within a spherical cap of half-angle `halfAngleRad`
// centered on `base`. Used to cluster a node near its inviter on the sphere.
function jitterDirectionNear(base: THREE.Vector3, rand: () => number, halfAngleRad: number) {
  // Pick a uniformly random axis perpendicular to base by sampling a random
  // unit vector and projecting onto base's tangent plane.
  const r = randomUnitVector(rand)
  const perp = r.sub(base.clone().multiplyScalar(r.dot(base)))
  if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0)
  perp.normalize()
  // Uniform distribution over the cap area uses sqrt of a uniform draw.
  const t = Math.sqrt(rand()) * halfAngleRad
  const c = Math.cos(t)
  const s = Math.sin(t)
  return base.clone().multiplyScalar(c).add(perp.multiplyScalar(s))
}

function createMultiHopRingTexture() {
  // Soft green ring drawn into a square canvas; used as a billboard halo on
  // multi-hop nodes so it always reads as a ring regardless of camera angle.
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const texture = new THREE.CanvasTexture(canvas)
  if (!ctx) return texture

  const cx = size / 2
  const cy = size / 2
  // Outer halo: wider, softer.
  ctx.save()
  ctx.globalAlpha = 0.55
  ctx.shadowColor = 'rgba(34,197,94,0.95)'
  ctx.shadowBlur = 18
  ctx.strokeStyle = 'rgba(74,222,128,0.95)'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(cx, cy, 42, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  // Inner crisp ring for definition.
  ctx.strokeStyle = 'rgba(187,247,208,0.9)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, 42, 0, Math.PI * 2)
  ctx.stroke()

  texture.needsUpdate = true
  return texture
}

function createCenterNodeTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return { canvas, texture: new THREE.CanvasTexture(canvas) }

  const cx = size / 2
  const cy = size / 2
  const r = 104

  // Background + subtle "frosted" look (approximation of blur).
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = 'rgba(21, 20, 22, 0.62)'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  // Add a touch of grain to sell the blur/frost.
  ctx.save()
  ctx.globalAlpha = 0.08
  for (let i = 0; i < 420; i += 1) {
    const x = Math.random() * size
    const y = Math.random() * size
    const rr = Math.random() * 1.8
    ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000'
    ctx.beginPath()
    ctx.arc(x, y, rr, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  // Soft glow / depth.
  ctx.save()
  ctx.globalAlpha = 0.45
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 24
  ctx.beginPath()
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // Stroke similar to Progress card.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return { canvas, texture }
}

export interface NodeSphereProps {
  /** When set, the matching node is emphasized. */
  highlightAddress?: string
  /** Notify when a node is selected via click. */
  onSelectAddress?: (address: string | undefined) => void
  /** When set, non-matching nodes are dimmed. */
  filterKind?: 'Hop 0' | 'Hop 1' | 'Hop 2' | 'Multi-hop'
  /** Disable pointer interactions so overlays can scroll/capture wheel. */
  interactionDisabled?: boolean
  /**
   * Optional list of nodes to "pin" into the generated graph, by replacing the
   * first N node addresses per kind. Used to connect UI lists to the sphere.
   */
  pinnedNodes?: PinnedNode[]
  /** Participant scenario size chosen by the page (stable per reload). 0 means
   *  pre-launch (ghost-only sphere); any positive number means active. */
  scenarioParticipants?: number
  /** Seed for deterministic layout within a single reload. */
  scenarioSeed?: number
  /** When set, a dedicated "Your wallet" node is rendered at this address. */
  walletAddress?: string
  /** Keep focus/zoom pinned on the wallet node; disables auto-rotate. */
  lockOnWallet?: boolean
  /** Restrict selection + emphasis to the wallet and its nearest hop-1 nodes. */
  inviteGraph?: boolean
  /**
   * Block-explorer base URL (e.g. `'https://sepolia.etherscan.io'`). When
   * provided, the selected-node tooltip's top-right icon becomes a link that
   * opens `${etherscanBaseUrl}/address/<full-address>` in a new tab. Omit
   * for local mode where no explorer exists.
   */
  etherscanBaseUrl?: string
}

export function NodeSphere({
  highlightAddress,
  onSelectAddress,
  filterKind,
  interactionDisabled,
  pinnedNodes,
  // Accepted for backward-compat / API stability — the upgraded NodeSphere no
  // longer derives behavior from a discrete scenario size; the pinnedNodes
  // input + tree edges are what matter now. Prefix with `_` so noUnusedLocals
  // doesn't complain while still letting callers pass the prop.
  scenarioParticipants: _scenarioParticipants,
  scenarioSeed,
  walletAddress,
  lockOnWallet = false,
  inviteGraph = false,
  etherscanBaseUrl,
}: NodeSphereProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [selectedTip, setSelectedTip] = useState<HoverState | null>(null)
  const hoverActiveRef = useRef(false)
  const isDraggingRef = useRef(false)
  const highlightRef = useRef<string | undefined>(highlightAddress)
  const filterRef = useRef<NodeSphereProps['filterKind']>(filterKind)
  const interactionDisabledRef = useRef(!!interactionDisabled)
  const walletAddressRef = useRef(walletAddress)
  const lockOnWalletRef = useRef(lockOnWallet)
  const inviteGraphRef = useRef(inviteGraph)
  const onSelectAddressRef = useRef(onSelectAddress)
  const selectedTipRef = useRef<HoverState | null>(null)
  const rendererElRef = useRef<HTMLCanvasElement | null>(null)

  const seed = useMemo(() => {
    // Stable per mount, changes on reload unless caller provides a seed.
    return scenarioSeed ?? Math.floor(Math.random() * 1_000_000_000)
  }, [scenarioSeed])

  // Avoid tearing down/recreating Three.js scene due to new array references.
  // `multiHop` and `inviters` are baked into the key so the scene rebuilds when
  // a wallet gains a new hop (e.g. self-invite flips it from single- to
  // multi-hop) or its incoming-edge set changes. Without these, the cached key
  // stays identical and the halo / edges only appear on the next full reload.
  const pinnedNodesKey = useMemo(() => {
    if (!pinnedNodes?.length) return ''
    return pinnedNodes
      .map(
        (p) =>
          `${p.kind}:${p.address}:${p.committed ?? ''}:${p.multiHop ? 'm' : ''}:${
            p.inviters?.join(',') ?? ''
          }`,
      )
      .join('|')
  }, [pinnedNodes])

  useEffect(() => {
    highlightRef.current = highlightAddress
  }, [highlightAddress])

  useEffect(() => {
    filterRef.current = filterKind
  }, [filterKind])

  useEffect(() => {
    interactionDisabledRef.current = !!interactionDisabled
  }, [interactionDisabled])

  useEffect(() => {
    walletAddressRef.current = walletAddress
  }, [walletAddress])

  useEffect(() => {
    lockOnWalletRef.current = lockOnWallet
  }, [lockOnWallet])

  useEffect(() => {
    inviteGraphRef.current = inviteGraph
  }, [inviteGraph])

  useEffect(() => {
    onSelectAddressRef.current = onSelectAddress
  }, [onSelectAddress])

  useEffect(() => {
    const el = rendererElRef.current
    if (!el) return
    el.style.pointerEvents = interactionDisabled ? 'none' : 'auto'
  }, [interactionDisabled])

  // Stable id so we can safely attach events once.
  const instanceId = useMemo(() => Math.random().toString(36).slice(2), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    // Z_DEFAULT is the unfocused zoom level — matches the designer's "start
    // at max zoom" baseline. Z_MIN/Z_MAX bound user wheel zoom and the focus
    // lerp target; deselecting eases the camera back to Z_DEFAULT.
    const Z_MIN = 6
    const Z_MAX = 28
    const Z_DEFAULT = Z_MIN
    camera.position.z = Z_DEFAULT

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.domElement.style.position = 'absolute'
    renderer.domElement.style.inset = '0'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.pointerEvents = interactionDisabled ? 'none' : 'auto'
    rendererElRef.current = renderer.domElement
    host.appendChild(renderer.domElement)

    // Root handles free rotation (auto + drag). Focus handles selection-centering offset.
    const root = new THREE.Group()
    const focus = new THREE.Group()
    root.add(focus)
    scene.add(root)

    const rand = mulberry32(seed)

    const NODE_RADIUS = 0.085

    // Higher segment count so nodes read as true circles.
    const nodeGeometry = new THREE.SphereGeometry(NODE_RADIUS, 28, 20)
    const baseMaterialsByKind = new Map<NodeKind, THREE.MeshBasicMaterial>(
      (Object.keys(COLORS) as NodeKind[]).map(kind => ([
        kind,
        new THREE.MeshBasicMaterial({
          color: COLORS[kind],
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
        }),
      ])),
    )

    const nodeMeshes: THREE.Mesh[] = []
    const nodePositions: THREE.Vector3[] = []
    const indicesByKind = new Map<NodeKind, number[]>()
    const indexByAddress = new Map<string, number>()
    // Parallel to nodeMeshes; entry is the halo material when the node is
    // multi-hop, otherwise null. Each multi-hop node gets its own material
    // clone so lineage dimming can fade halos individually.
    const haloMaterials: Array<THREE.SpriteMaterial | null> = []

    // Template material for the multi-hop halo billboard. Cloned per node so
    // each instance can be dimmed independently.
    const multiHopRingTexture = createMultiHopRingTexture()
    const multiHopRingMaterialTemplate = new THREE.SpriteMaterial({
      map: multiHopRingTexture,
      transparent: true,
      depthWrite: false,
    })

    const shellRadii: Array<{ kind: NodeKind; radius: number }> = [
      { kind: 'Hop 0', radius: 2.4 },
      { kind: 'Hop 1', radius: 3.6 },
      { kind: 'Hop 2', radius: 5.1 },
      { kind: 'Multi-hop', radius: 6.4 },
    ]

    const pinnedByKind = new Map<NodeKind, PinnedNode[]>()
    if (pinnedNodes?.length) {
      for (const p of pinnedNodes) {
        const list = pinnedByKind.get(p.kind) ?? []
        list.push(p)
        pinnedByKind.set(p.kind, list)
      }
    }

    const scenarioCounts = (() => {
      // When a pinned dataset is provided (the live crowdfund mock), render
      // exactly one node per pinned entry on each shell. No synthetic padding.
      if (pinnedNodes?.length) {
        return {
          real: {
            hop0: pinnedByKind.get('Hop 0')?.length ?? 0,
            hop1: pinnedByKind.get('Hop 1')?.length ?? 0,
            hop2: pinnedByKind.get('Hop 2')?.length ?? 0,
            multi: pinnedByKind.get('Multi-hop')?.length ?? 0,
          },
          ghost: { hop0: 0, hop1: 0, hop2: 0, multi: 0 },
        }
      }
      // Fallback for the empty (pre-launch) scenario: a sparse set of ghost
      // nodes so the sphere still has visual content.
      return {
        real: { hop0: 0, hop1: 0, hop2: 0, multi: 0 },
        ghost: { hop0: 6, hop1: 10, hop2: 14, multi: 0 },
      }
    })()
    const pinnedIndex = new Map<NodeKind, number>()
    const takePinned = (kind: NodeKind): PinnedNode | null => {
      const list = pinnedByKind.get(kind)
      if (!list?.length) return null
      const idx = pinnedIndex.get(kind) ?? 0
      if (idx >= list.length) return null
      pinnedIndex.set(kind, idx + 1)
      return list[idx]
    }

    const pushNode = (pos: THREE.Vector3, meta: NodeMeta) => {
      nodePositions.push(pos)
      const mat = baseMaterialsByKind.get(meta.kind)!.clone()
      if (meta.ghost) {
        mat.color = new THREE.Color(0xa1a1aa)
        mat.opacity = 0.12
      }
      const mesh = new THREE.Mesh(nodeGeometry, mat)
      mesh.position.copy(pos)
      mesh.userData = meta
      focus.add(mesh)
      nodeMeshes.push(mesh)

      let haloMat: THREE.SpriteMaterial | null = null
      if (meta.multiHop && !meta.ghost) {
        haloMat = multiHopRingMaterialTemplate.clone()
        const halo = new THREE.Sprite(haloMat)
        const haloScale = NODE_RADIUS * 5.2
        halo.scale.set(haloScale, haloScale, 1)
        mesh.add(halo)
      }
      haloMaterials.push(haloMat)

      const idx = nodeMeshes.length - 1
      if (!meta.ghost) {
        const list = indicesByKind.get(meta.kind) ?? []
        list.push(idx)
        indicesByKind.set(meta.kind, list)
        indexByAddress.set(meta.address, idx)
      }
    }

    // Half-angle of the spherical cap a child node may occupy around its
    // inviter's direction. Tighter on outer shells so clusters read clearly.
    const CLUSTER_HALF_ANGLE: Partial<Record<NodeKind, number>> = {
      'Hop 1': 0.28,
      'Hop 2': 0.22,
    }

    const addShell = (kind: NodeKind, radius: number, realCount: number, ghostCount: number) => {
      const total = realCount + ghostCount
      const clusterAngle = CLUSTER_HALF_ANGLE[kind]
      for (let i = 0; i < total; i += 1) {
        const ghost = i >= realCount
        const pinned = ghost ? null : takePinned(kind)

        // Cluster a child near ONE of its inviters — multi-hop wallets have
        // several, but each node has a single position on the sphere, so we
        // pick the first non-root inviter that's already been placed. The
        // root-anchored edge still renders separately; this just chooses the
        // spatial parent for the cluster jitter.
        let dir: THREE.Vector3
        const inviters = pinned?.inviters ?? []
        let parentIdx: number | undefined
        if (clusterAngle) {
          for (const inv of inviters) {
            if (isArmadaSentinel(inv)) continue
            const idx = indexByAddress.get(inv)
            if (idx != null) {
              parentIdx = idx
              break
            }
          }
        }
        if (parentIdx != null) {
          const parentDir = nodePositions[parentIdx].clone().normalize()
          dir = jitterDirectionNear(parentDir, rand, clusterAngle as number)
        } else {
          dir = randomUnitVector(rand)
        }

        const jitter = (rand() - 0.5) * 0.18
        const pos = dir.multiplyScalar(radius + jitter)
        pushNode(pos, {
          kind,
          address: pinned?.address ?? makeAddress(rand),
          committed: pinned?.committed ?? makeCommitted(rand),
          ghost,
          multiHop: pinned?.multiHop,
          inviters: pinned?.inviters,
        })
      }
    }

    addShell('Hop 0', shellRadii[0].radius, scenarioCounts.real.hop0, scenarioCounts.ghost.hop0)
    addShell('Hop 1', shellRadii[1].radius, scenarioCounts.real.hop1, scenarioCounts.ghost.hop1)
    addShell('Hop 2', shellRadii[2].radius, scenarioCounts.real.hop2, scenarioCounts.ghost.hop2)
    addShell('Multi-hop', shellRadii[3].radius, scenarioCounts.real.multi, scenarioCounts.ghost.multi)

    // Resolve `walletAddress` against the actual participant set. We do NOT
    // render a synthetic placeholder when the wallet isn't a participant —
    // doing so would put a yellow node at an arbitrary outer-radius position
    // with no edges to anyone in the tree, which is decoration rather than
    // an honest data representation. When the wallet has no entry here,
    // `walletIdx` stays null and the lock/focus/inviteGraph behaviors
    // gracefully no-op (see the `walletIdx != null` guards below).
    //
    // TODO: scene rebuild is keyed on [instanceId, pinnedNodesKey, seed] —
    // a `walletAddress` change without a `pinnedNodes` change would not
    // refresh `walletIdx`. Acceptable today since wallet swaps either come
    // with a pinned-data refresh or a remount; revisit if that changes.
    const walletIdx = walletAddress
      ? (indexByAddress.get(walletAddress) ?? null)
      : null

    // Center node (Armada symbol inside frosted circle) as a true 3D sprite.
    const { texture: centerBgTexture } = createCenterNodeTexture()
    const centerMat = new THREE.SpriteMaterial({
      map: centerBgTexture,
      transparent: true,
      depthWrite: false,
    })
    const centerSprite = new THREE.Sprite(centerMat)
    centerSprite.position.set(0, 0, 0)
    // World-space size so it zooms/scales with the sphere (like other nodes).
    centerSprite.scale.set(0.9, 0.9, 1)

    // Load and draw the SVG symbol into the same canvas texture.
    const img = new Image()
    img.onload = () => {
      const canvas = centerBgTexture.image as HTMLCanvasElement
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const size = canvas.width
      const cx = size / 2
      const cy = size / 2
      const symbolSize = 140
      ctx.save()
      ctx.globalAlpha = 1
      ctx.drawImage(img, cx - symbolSize / 2, cy - symbolSize / 2, symbolSize, symbolSize)
      ctx.restore()
      centerBgTexture.needsUpdate = true
    }
    img.src = armadaSymbolUrl

    focus.add(centerSprite)

    const edgePositions: number[] = []
    // Each edge endpoint is either a wallet address or the sentinel 'Armada'
    // (which corresponds to the center sprite, not a node in nodeMeshes).
    const edgePairs: Array<[string, string]> = []

    // Invite-tree maps used both for edge construction and selection lineage
    // walks. Multi-hop wallets can have multiple inviters, so `parentOf` is a
    // set-per-address; `childrenOf` is symmetric. The walk below treats the
    // graph as undirected for lineage purposes (your "tree" is every ancestor
    // and descendant reachable through any invite edge).
    const parentsOf = new Map<string, Set<string>>()
    const childrenOf = new Map<string, Set<string>>()

    // Build one edge per (wallet → inviter) pair. A multi-hop seed (hop-0 +
    // hop-1) emits two edges: one to the center sprite (Armada) and one to
    // its hop-1 inviter. Armada-direct wallets terminate at (0,0,0).
    for (let i = 0; i < nodeMeshes.length; i += 1) {
      const m = nodeMeshes[i]
      const meta = m.userData as NodeMeta
      if (meta.ghost) continue
      const inviters = meta.inviters
      if (!inviters?.length) continue

      const from = nodePositions[i]
      for (const inviter of inviters) {
        const parents = parentsOf.get(meta.address) ?? new Set<string>()
        parents.add(inviter)
        parentsOf.set(meta.address, parents)
        const siblings = childrenOf.get(inviter) ?? new Set<string>()
        siblings.add(meta.address)
        childrenOf.set(inviter, siblings)

        let toX = 0
        let toY = 0
        let toZ = 0
        if (!isArmadaSentinel(inviter)) {
          const parentIdx = indexByAddress.get(inviter)
          if (parentIdx == null) continue
          const parent = nodePositions[parentIdx]
          toX = parent.x
          toY = parent.y
          toZ = parent.z
        }
        edgePositions.push(from.x, from.y, from.z, toX, toY, toZ)
        edgePairs.push([meta.address, inviter])
      }
    }

    // Walk ancestors + descendants for selection-time lineage highlighting.
    // The ancestor walk is BFS now that a node can have multiple parents
    // (multi-hop wallets). The visited-set guard is load-bearing: multi-hop
    // and self-invite participants can create cycles in `parentsOf` (e.g.
    // the realistic mock's `SELF_INVITE_FRACTION` makes `parentsOf[X]`
    // include X, and live multi-hop wallets can invite the same address back
    // at a later hop). Without the visited check we'd loop forever and lock
    // up the render thread on selection.
    const computeLineage = (addr: string): Set<string> => {
      const set = new Set<string>()
      set.add(addr)
      // Ancestors via BFS — every parent of every visited node.
      const upQueue: string[] = [addr]
      while (upQueue.length) {
        const n = upQueue.shift() as string
        const parents = parentsOf.get(n)
        if (!parents) continue
        for (const p of parents) {
          if (set.has(p)) continue
          set.add(p)
          if (!isArmadaSentinel(p)) upQueue.push(p)
        }
      }
      // Descendants via BFS.
      const downQueue: string[] = [addr]
      while (downQueue.length) {
        const n = downQueue.shift() as string
        const kids = childrenOf.get(n)
        if (!kids) continue
        for (const k of kids) {
          if (!set.has(k)) {
            set.add(k)
            downQueue.push(k)
          }
        }
      }
      return set
    }

    // Edges are split across two LineSegments objects so they can have
    // independent material opacities: a "background" set for non-tree edges
    // and a "tree" set for edges on the selected lineage path. At idle, all
    // edges live in the background object.
    const allEdgePositions = new Float32Array(edgePositions)

    const bgEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0xc491e5,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })
    const treeEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0xffe4a3,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    })

    const bgEdgeGeometry = new THREE.BufferGeometry()
    bgEdgeGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(allEdgePositions.slice(), 3),
    )
    const bgEdges = new THREE.LineSegments(bgEdgeGeometry, bgEdgeMaterial)
    focus.add(bgEdges)

    const treeEdgeGeometry = new THREE.BufferGeometry()
    treeEdgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
    const treeEdges = new THREE.LineSegments(treeEdgeGeometry, treeEdgeMaterial)
    focus.add(treeEdges)

    // Lock/inviteGraph features only fire when the wallet is a real
    // participant in the rendered graph — otherwise there's nothing to lock
    // onto, and the dimming would just hide the whole sphere.
    const isWalletLocked = () => lockOnWalletRef.current && walletIdx != null
    const isInviteFocusMode = () =>
      inviteGraphRef.current && lockOnWalletRef.current && walletIdx != null
    // Restrict clicks/hover in invite-focus mode to nodes that share a
    // lineage with the wallet — i.e. ancestors + descendants via the real
    // invite tree (`parentOf` / `childrenOf`). This piggybacks on
    // `currentLineage`, which `updateEdgeHighlight` keeps in sync with the
    // current selection. In My Position view that selection is the wallet
    // itself (highlightAddress defaults to it), so `currentLineage` is
    // exactly the set of nodes "in your invite tree". Early Phase-4b builds
    // used a synthetic Euclidean-nearest hop-1 set here because the wallet
    // wasn't yet a real graph node — that constraint is gone now that
    // live data places the wallet at its actual hop.
    const isSelectableNode = (mesh: THREE.Mesh): boolean => {
      const meta = mesh.userData as NodeMeta
      if (meta.ghost) return false
      if (!isInviteFocusMode()) return true
      if (!currentLineage) return false
      return currentLineage.has(meta.address)
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let hovered: THREE.Mesh | null = null
    let dragLastX = 0
    let dragLastY = 0
    let pointerDownX = 0
    let pointerDownY = 0
    // Squared distance threshold (px²) used to tell a click from a drag.
    const CLICK_DRAG_THRESHOLD_SQ = 25

    let raf = 0
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host
      if (w === 0 || h === 0) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - dragLastX
        const dy = e.clientY - dragLastY
        dragLastX = e.clientX
        dragLastY = e.clientY

        // Drag rotation: right-drag rotates around Y, up/down rotates around X.
        root.rotation.y += dx * 0.006
        root.rotation.x += dy * 0.004
        return
      }

      const rect = renderer.domElement.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      pointer.x = (x / rect.width) * 2 - 1
      pointer.y = -(y / rect.height) * 2 + 1

      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(nodeMeshes, false)
      const hit = hits[0]?.object as THREE.Mesh | undefined

      if (hit && hit.userData?.kind && isSelectableNode(hit)) {
        hovered = hit
        const meta = hit.userData as NodeMeta
        hoverActiveRef.current = true
        setHover({
          visible: true,
          x: e.clientX + 14,
          y: e.clientY + 14,
          kind: meta.kind,
          address: meta.address,
          committed: meta.committed,
        })
      } else {
        hovered = null
        hoverActiveRef.current = false
        setHover(null)
      }
    }

    const onPointerLeave = () => {
      hovered = null
      hoverActiveRef.current = false
      setHover(null)
    }

    const onPointerDown = (e: PointerEvent) => {
      isDraggingRef.current = true
      dragLastX = e.clientX
      dragLastY = e.clientY
      pointerDownX = e.clientX
      pointerDownY = e.clientY
      hoverActiveRef.current = false
      setHover(null)
      renderer.domElement.setPointerCapture(e.pointerId)
    }

    const onPointerUp = (e: PointerEvent) => {
      isDraggingRef.current = false
      try {
        renderer.domElement.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }

      const onSelect = onSelectAddressRef.current
      if (!onSelect) return

      // If the pointer moved more than the click/drag threshold between down
      // and up, treat the gesture as a drag and leave selection unchanged.
      const dx = e.clientX - pointerDownX
      const dy = e.clientY - pointerDownY
      if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_SQ) return

      // Click-to-select: raycast on pointer up.
      const rect = renderer.domElement.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      pointer.x = (x / rect.width) * 2 - 1
      pointer.y = -(y / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(nodeMeshes, false)
      const hit = hits.find((h) => isSelectableNode(h.object as THREE.Mesh))?.object as
        | THREE.Mesh
        | undefined
      const meta = hit?.userData as NodeMeta | undefined
      const addr = meta ? meta.address : undefined
      const current = highlightRef.current
      const nextAddr = addr && addr !== current ? addr : undefined
      onSelect(nextAddr)
      // Lock-on-wallet: deselecting snaps focus back to the wallet rather than
      // releasing to free-orbit mode, so the My Position view stays zoomed in.
      // Only snaps back when the wallet is a real graph node (`walletIdx`
      // non-null); otherwise there's no node to focus on and we fall through
      // to `undefined`.
      highlightRef.current =
        nextAddr ??
        (isWalletLocked() && walletAddressRef.current
          ? walletAddressRef.current
          : undefined)
    }

    const onWheel = (e: WheelEvent) => {
      // If a UI overlay is on top (e.g. the participants list), don't hijack the wheel.
      // In some browsers, the canvas can still receive wheel events even when visually covered.
      if (interactionDisabledRef.current) return
      const top = document.elementFromPoint(e.clientX, e.clientY)
      if (top && top !== renderer.domElement && !renderer.domElement.contains(top)) return

      e.preventDefault()
      // Mark the view as user-adjusted so the focus-zoom lerp stops chasing
      // the auto-computed target while the user is scrolling.
      userAdjustedView = true
      cameraResetActive = false
      const next = camera.position.z + e.deltaY * 0.01
      camera.position.z = Math.max(Z_MIN, Math.min(Z_MAX, next))
      targetCameraZ = camera.position.z
    }

    let lastHighlightedAddress: string | null = null

    // Cached lineage set for the current selection. Read by the per-frame node
    // loop to dim non-lineage nodes; written by updateEdgeHighlight when the
    // selection changes.
    let currentLineage: Set<string> | null = null

    // Focus/zoom state. The focus group is a child of root: selection rotates
    // `focus` to bring the selected node into a fixed corner of the viewport,
    // while `root` keeps the free auto-rotate / drag rotation. On deselect we
    // bake `focus` back into `root` so the visible frame doesn't snap.
    const identityQuat = new THREE.Quaternion()
    let targetFocusQuat: THREE.Quaternion | null = null
    let lastCenteredAddress: string | null = null
    let hadSelection = false
    let cameraResetActive = false
    let userAdjustedView = false

    // Focused nodes sit slightly right and above center so tooltips have room.
    const FOCUS_OFFSET_X = 0.18
    const FOCUS_OFFSET_Y = 0.1
    const FOCUS_INNER_RADIUS = 2.6
    const FOCUS_OUTER_RADIUS = 6.2
    const FOCUS_ZOOM_OUT_MAX = 0.65
    const INVITE_FOCUS_ZOOM_OUT_MAX = 0.3
    const CAMERA_Z_LERP = 0.08
    const focusTargetWorld = new THREE.Vector3()
    const getFocusTargetWorld = (focused: boolean) => {
      if (!focused) return focusTargetWorld.set(0, 0, 1)
      return focusTargetWorld.set(FOCUS_OFFSET_X, FOCUS_OFFSET_Y, 1).normalize()
    }
    const cameraZForNodeRadius = (radius: number, zoomOutMax: number) => {
      const t = THREE.MathUtils.clamp(
        (radius - FOCUS_INNER_RADIUS) / (FOCUS_OUTER_RADIUS - FOCUS_INNER_RADIUS),
        0,
        1,
      )
      return THREE.MathUtils.lerp(Z_MIN, Z_MAX, t * zoomOutMax)
    }
    let targetCameraZ = Z_DEFAULT

    // Opacity targets for the two edge materials in the two states.
    const BG_OPACITY_IDLE = 0.3
    const BG_OPACITY_DIMMED = 0.08
    const TREE_OPACITY = 0.7

    const updateEdgeHighlight = (addr: string | null) => {
      if (addr === lastHighlightedAddress) return
      lastHighlightedAddress = addr

      if (!addr) {
        currentLineage = null
        // Restore: all edges in the background pass at full default opacity,
        // tree pass empty.
        bgEdgeGeometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(allEdgePositions.slice(), 3),
        )
        treeEdgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
        bgEdgeMaterial.opacity = BG_OPACITY_IDLE
        return
      }

      currentLineage = computeLineage(addr)

      // Degenerate lineage (just the selected address — happens when the node
      // isn't in the invite tree, e.g. the dedicated wallet node) carries no
      // useful tree-edge information. Skip the partition and leave edges at
      // their idle background opacity so the sphere doesn't dim to a sliver.
      if (currentLineage.size < 2) {
        bgEdgeGeometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(allEdgePositions.slice(), 3),
        )
        treeEdgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
        bgEdgeMaterial.opacity = BG_OPACITY_IDLE
        return
      }

      // Partition every edge by whether both endpoints are inside the lineage
      // (treating 'Armada' as always in, so the edges to the center stay tree).
      const treePos: number[] = []
      const bgPos: number[] = []
      for (let s = 0; s < edgePairs.length; s += 1) {
        const [a, b] = edgePairs[s]
        const aIn = isArmadaSentinel(a) || currentLineage.has(a)
        const bIn = isArmadaSentinel(b) || currentLineage.has(b)
        const base = s * 6
        if (aIn && bIn) {
          for (let k = 0; k < 6; k += 1) treePos.push(allEdgePositions[base + k])
        } else {
          for (let k = 0; k < 6; k += 1) bgPos.push(allEdgePositions[base + k])
        }
      }
      bgEdgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bgPos, 3))
      treeEdgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(treePos, 3))
      bgEdgeMaterial.opacity = BG_OPACITY_DIMMED
      treeEdgeMaterial.opacity = TREE_OPACITY
    }

    const animate = () => {
      const selectedAddr = highlightRef.current
      updateEdgeHighlight(selectedAddr ?? null)

      // Bake the focused orientation into root the moment we deselect, then
      // reset focus to identity so the visible frame doesn't snap. Also kick
      // off the camera-Z ease back to the unfocused default.
      if (!selectedAddr && hadSelection) {
        root.quaternion.multiply(focus.quaternion)
        focus.quaternion.copy(identityQuat)
        hadSelection = false
        targetFocusQuat = null
        lastCenteredAddress = null
        targetCameraZ = Z_DEFAULT
        userAdjustedView = false
        cameraResetActive = true
      }

      const shouldAutoRotate =
        !isWalletLocked() &&
        !selectedAddr &&
        !hoverActiveRef.current &&
        !isDraggingRef.current
      if (shouldAutoRotate) {
        root.rotation.y += 0.001
        root.rotation.x += 0.0003
      }

      // Subtle emphasis on hovered node; lineage-aware dimming when selected
      // (and always-on under invite-focus, since the wallet's lineage is the
      // intended "your invite tree" subset). Crowdfund-view selection and
      // invite-focus mode now share the same code path — the wallet became
      // a real graph node post-Phase 4b.3, so its ancestors + descendants
      // via `parentOf` / `childrenOf` carry the invite-tree semantics that
      // an earlier synthetic Euclidean-nearest workaround used to fake.
      for (let i = 0; i < nodeMeshes.length; i += 1) {
        const m = nodeMeshes[i]
        const isHovered = hovered === m
        const meta = m.userData as NodeMeta
        const isSelected = !!selectedAddr && meta.address === selectedAddr
        const activeFilter = filterRef.current
        const isFilteredOut =
          !!activeFilter &&
          meta.kind !== 'Your wallet' &&
          (activeFilter === 'Multi-hop' ? !meta.multiHop : meta.kind !== activeFilter)
        const isOutsideLineage = !!currentLineage && !currentLineage.has(meta.address)
        const isDimmed = isFilteredOut || (isOutsideLineage && !isSelected)
        const target = Math.max(isHovered ? 1.35 : 1, isSelected ? 1.55 : 1)
        const s = m.scale.x + (target - m.scale.x) * 0.15
        m.scale.setScalar(s)

        const mat = m.material as THREE.MeshBasicMaterial
        const base = meta.ghost ? 0.12 : 0.6
        const targetOpacity = isSelected ? 1 : isDimmed ? (meta.ghost ? 0.06 : 0.08) : base
        mat.opacity = mat.opacity + (targetOpacity - mat.opacity) * 0.12

        const haloMat = haloMaterials[i]
        if (haloMat) {
          const haloTarget = isSelected ? 1 : isDimmed ? 0.08 : 1
          haloMat.opacity = haloMat.opacity + (haloTarget - haloMat.opacity) * 0.12
        }
      }

      // Center focused node by rotating the focus group; lerp camera Z toward
      // a target based on the node's radius. While there's no selection but we
      // were just deselected, ease the camera back to Z_DEFAULT.
      if (selectedAddr && !isDraggingRef.current) {
        hadSelection = true
        if (lastCenteredAddress !== selectedAddr) {
          userAdjustedView = false
          const selectedMesh =
            nodeMeshes.find((m) => (m.userData as NodeMeta).address === selectedAddr) ?? null
          if (selectedMesh) {
            const desiredWorld = getFocusTargetWorld(true)
            const desiredInFocusSpace = desiredWorld
              .clone()
              .applyQuaternion(root.quaternion.clone().invert())
              .normalize()
            const from = selectedMesh.position.clone().normalize()
            targetFocusQuat = new THREE.Quaternion().setFromUnitVectors(
              from,
              desiredInFocusSpace,
            )
            const zoomOutMax = isInviteFocusMode() ? INVITE_FOCUS_ZOOM_OUT_MAX : FOCUS_ZOOM_OUT_MAX
            targetCameraZ = cameraZForNodeRadius(selectedMesh.position.length(), zoomOutMax)
          }
          lastCenteredAddress = selectedAddr
        }
        if (!userAdjustedView) {
          if (targetFocusQuat) focus.quaternion.slerp(targetFocusQuat, 0.08)
          if (Math.abs(camera.position.z - targetCameraZ) > 0.08) {
            camera.position.z += (targetCameraZ - camera.position.z) * CAMERA_Z_LERP
          }
        }
      } else if (cameraResetActive) {
        targetCameraZ = Z_DEFAULT
        if (Math.abs(camera.position.z - Z_DEFAULT) > 0.08) {
          camera.position.z += (Z_DEFAULT - camera.position.z) * CAMERA_Z_LERP
        } else {
          camera.position.z = Z_DEFAULT
          cameraResetActive = false
        }
      }

      // Keep selected tooltip pinned near the selected node (when not hovering other nodes).
      if (selectedAddr && !hoverActiveRef.current) {
        const selectedMesh = nodeMeshes.find((m) => (m.userData as NodeMeta).address === selectedAddr) ?? null
        if (selectedMesh) {
          const meta = selectedMesh.userData as NodeMeta
          const world = new THREE.Vector3()
          selectedMesh.getWorldPosition(world)
          const projected = world.project(camera)
          const rect = renderer.domElement.getBoundingClientRect()
          const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width + 14
          const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height - 12

          const next: HoverState = {
            visible: true,
            x,
            y,
            kind: meta.kind,
            address: meta.address,
            committed: meta.committed,
          }

          const prev = selectedTipRef.current
          const shouldUpdate =
            !prev ||
            prev.address !== next.address ||
            Math.abs(prev.x - next.x) > 0.5 ||
            Math.abs(prev.y - next.y) > 0.5

          if (shouldUpdate) {
            selectedTipRef.current = next
            setSelectedTip(next)
          }
        }
      } else if (selectedTipRef.current) {
        selectedTipRef.current = null
        setSelectedTip(null)
      }

      renderer.render(scene, camera)
      raf = window.requestAnimationFrame(animate)
    }

    resize()
    window.addEventListener('resize', resize)
    // Tie events to renderer canvas so the sphere stays centered regardless of layout.
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('pointercancel', onPointerUp)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
    raf = window.requestAnimationFrame(animate)

    return () => {
      window.removeEventListener('resize', resize)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointercancel', onPointerUp)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('wheel', onWheel)
      window.cancelAnimationFrame(raf)

      root.clear()
      nodeGeometry.dispose()
      for (const mat of baseMaterialsByKind.values()) mat.dispose()
      bgEdgeGeometry.dispose()
      treeEdgeGeometry.dispose()
      bgEdgeMaterial.dispose()
      treeEdgeMaterial.dispose()
      centerBgTexture.dispose()
      centerMat.dispose()
      multiHopRingMaterialTemplate.dispose()
      for (const mat of haloMaterials) {
        if (mat) mat.dispose()
      }
      multiHopRingTexture.dispose()

      renderer.dispose()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
    }
  }, [instanceId, pinnedNodesKey, seed])

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
      }}
    >
      {/* Hover tooltip — follows the cursor over selectable nodes. Mirrors
          the selected-tip's "Your wallet" eyebrow + truncated-address
          rendering so live 40-hex addresses don't overflow the 272px box. */}
      {SHOW_HOVER_POPUP && hover && hover.visible && (() => {
        const hoverIsOwnWallet =
          !!walletAddress && hover.address.toLowerCase() === walletAddress.toLowerCase()
        const hoverEyebrow = hoverIsOwnWallet ? 'Your wallet' : hover.kind
        const hoverTruncated =
          hover.address.length > 12
            ? `${hover.address.slice(0, 6)}…${hover.address.slice(-4)}`
            : hover.address
        return (
        <div
          style={{
            position: 'fixed',
            left: hover.x,
            top: hover.y,
            zIndex: 30,
            width: '272px',
            padding: 'var(--primitives-spacing-5)',
            borderRadius: 'calc(var(--semantic-borderRadius-card) * 1px)',
            border: '1px solid color-mix(in srgb, var(--semantic-color-text-primary) 16%, transparent)',
            background: 'color-mix(in srgb, var(--semantic-color-surface-default) 55%, transparent)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            color: 'var(--semantic-color-text-secondary)',
            fontFamily: 'var(--primitives-fontFamily-ui), sans-serif',
            pointerEvents: 'none',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 'var(--primitives-spacing-4)',
              right: 'var(--primitives-spacing-4)',
              width: 16,
              height: 16,
              color: 'var(--semantic-color-text-dim)',
              opacity: 0.9,
            }}
            aria-hidden
          >
            <ArrowTopRightOnSquareIcon width={16} height={16} />
          </div>
          <div
            style={{
              fontSize: 'var(--semantic-component-tag-font-size)',
              letterSpacing: 'var(--primitives-letterSpacing-widest)',
              textTransform: 'uppercase',
              color: 'var(--semantic-color-text-secondary)',
              marginBottom: 'var(--primitives-spacing-2)',
            }}
          >
            {hoverEyebrow}
          </div>
          <div
            style={{
              fontFamily: 'var(--primitives-fontFamily-mono), monospace',
              fontSize: 'var(--primitives-fontSize-2xl)',
              letterSpacing: 'var(--primitives-letterSpacing-tight)',
              color: 'var(--semantic-color-text-primary)',
              marginBottom: 'var(--primitives-spacing-3)',
            }}
          >
            {hoverTruncated}
          </div>
          <div style={{ fontSize: 'var(--primitives-fontSize-lg)', opacity: 0.8, marginBottom: 'var(--primitives-spacing-2)' }}>
            {hover.committed}
          </div>
        </div>
        )
      })()}

      {/* Selected tooltip (pinned) */}
      {selectedTip?.visible && (() => {
        // Derive display fields. When the selected address is the connected
        // wallet, the tooltip's eyebrow swaps from the hop label to "YOUR
        // WALLET" (matches the designer's mockup). The address itself is
        // always truncated for display — live graph addresses are full
        // 40-hex hex and overflow the 272px tooltip width otherwise.
        const isOwnWallet =
          !!walletAddress && selectedTip.address.toLowerCase() === walletAddress.toLowerCase()
        const eyebrow = isOwnWallet ? 'Your wallet' : selectedTip.kind
        const truncated =
          selectedTip.address.length > 12
            ? `${selectedTip.address.slice(0, 6)}…${selectedTip.address.slice(-4)}`
            : selectedTip.address
        const explorerHref = etherscanBaseUrl
          ? `${etherscanBaseUrl}/address/${selectedTip.address}`
          : null
        return (
        <div
          style={{
            position: 'fixed',
            left: selectedTip.x,
            top: selectedTip.y,
            zIndex: 29,
            width: '272px',
            padding: 'var(--primitives-spacing-5)',
            borderRadius: 'calc(var(--semantic-borderRadius-card) * 1px)',
            border: '1px solid color-mix(in srgb, var(--semantic-color-text-primary) 16%, transparent)',
            background: 'color-mix(in srgb, var(--semantic-color-surface-default) 55%, transparent)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            color: 'var(--semantic-color-text-secondary)',
            fontFamily: 'var(--primitives-fontFamily-ui), sans-serif',
            // Tooltip is non-interactive for everything except the explorer
            // link, which restores its own pointer events below.
            pointerEvents: 'none',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
        >
          {explorerHref ? (
            <a
              href={explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View address on block explorer"
              // CrowdfundExperience attaches a window-level `pointerdown`
              // listener on the Crowdfund view that deselects the active node
              // for any click outside the participants panel. The tooltip is
              // outside that panel, so without `stopPropagation` here the
              // link's pointerdown would deselect — unmounting the tooltip
              // before the synthetic click ever resolves on the <a>. Stop the
              // propagation at the link itself; My Position doesn't install
              // the same listener, so the prior behavior is unchanged there.
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: 'var(--primitives-spacing-4)',
                right: 'var(--primitives-spacing-4)',
                width: 16,
                height: 16,
                color: 'var(--semantic-color-text-dim)',
                opacity: 0.9,
                pointerEvents: 'auto',
              }}
            >
              <ArrowTopRightOnSquareIcon width={16} height={16} />
            </a>
          ) : (
            <div
              style={{
                position: 'absolute',
                top: 'var(--primitives-spacing-4)',
                right: 'var(--primitives-spacing-4)',
                width: 16,
                height: 16,
                color: 'var(--semantic-color-text-dim)',
                opacity: 0.9,
              }}
              aria-hidden
            >
              <ArrowTopRightOnSquareIcon width={16} height={16} />
            </div>
          )}
          <div
            style={{
              fontSize: 'var(--semantic-component-tag-font-size)',
              letterSpacing: 'var(--primitives-letterSpacing-widest)',
              textTransform: 'uppercase',
              color: 'var(--semantic-color-text-secondary)',
              marginBottom: 'var(--primitives-spacing-2)',
            }}
          >
            {eyebrow}
          </div>
          <div
            style={{
              fontFamily: 'var(--primitives-fontFamily-mono), monospace',
              fontSize: 'calc(var(--primitives-fontSize-lg) * 1px)',
              fontWeight: 600,
              color: 'var(--semantic-color-text-primary)',
            }}
          >
            {truncated}
          </div>
          <div style={{ marginTop: 'var(--primitives-spacing-2)', color: 'var(--semantic-color-text-muted)' }}>
            {selectedTip.committed}
          </div>
        </div>
        )
      })()}
    </div>
  )
}


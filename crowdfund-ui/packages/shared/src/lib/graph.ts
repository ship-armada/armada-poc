// ABOUTME: Graph construction from crowdfund events.
// ABOUTME: Builds nodes, edges, and address summaries from the event stream.

import { HOP_CONFIGS } from './constants.js'
import type { CrowdfundEvent } from './events.js'

/** A node in the invite graph, representing one address at one hop level */
export interface GraphNode {
  address: string
  hop: number
  invitesReceived: number
  committed: bigint
  rawDeposited: bigint
  invitedBy: string[]
  invitesUsed: number
  invitesAvailable: number
  allocatedArm: bigint | null
  acceptedUsdc: bigint | null
}

/** A directed edge in the invite graph */
export interface GraphEdge {
  fromAddress: string
  fromHop: number
  toAddress: string
  toHop: number
}

/** Aggregate summary for a single address across all hops */
export interface AddressSummary {
  address: string
  hops: number[]
  totalCommitted: bigint
  perHop: Map<number, bigint>
  /** Single inviter chosen for compact UI surfaces (table cells, hover chips).
   *  Multi-hop wallets prefer a real (non-root) inviter — see `computeDisplayInviter`. */
  displayInviter: string
  /** Every unique inviter across all of the address's hop entries, including the
   *  `'armada'` root sentinel where applicable. Drives the NodeSphere edge set —
   *  a multi-hop seed gets BOTH its Armada edge and its human-inviter edge. */
  allInviters: string[]
  allocatedArm: bigint | null
  refundUsdc: bigint | null
  allocatedPerHop: Map<number, bigint>
  armClaimed: boolean
  refundClaimed: boolean
  delegate: string | null
}

/** The complete graph state derived from events */
export interface CrowdfundGraph {
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  summaries: Map<string, AddressSummary>
  /** All events used to build this graph — retained for incremental merges */
  events: CrowdfundEvent[]
}

/** Sentinel address representing the Armada root in the invite tree */
const ROOT_ADDRESS = 'armada'

/** Build a node key from address + hop */
function nodeKey(address: string, hop: number): string {
  return `${address}-${hop}`
}

/** Get or create a node */
function getOrCreateNode(nodes: Map<string, GraphNode>, address: string, hop: number): GraphNode {
  const key = nodeKey(address, hop)
  let node = nodes.get(key)
  if (!node) {
    const maxInvites = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop].maxInvites : 0
    node = {
      address,
      hop,
      invitesReceived: 0,
      committed: 0n,
      rawDeposited: 0n,
      invitedBy: [],
      invitesUsed: 0,
      invitesAvailable: maxInvites,
      allocatedArm: null,
      acceptedUsdc: null,
    }
    nodes.set(key, node)
  }
  return node
}

/** Recompute committed (capped) from rawDeposited and invitesReceived */
function recomputeCommitted(node: GraphNode): void {
  const cap = node.hop < HOP_CONFIGS.length ? HOP_CONFIGS[node.hop].capUsdc : 0n
  const maxCommit = BigInt(node.invitesReceived) * cap
  node.committed = node.rawDeposited < maxCommit ? node.rawDeposited : maxCommit
}

/**
 * Determine the display inviter string for an address summary.
 * - hop-0 only → "Armada"
 * - Same inviter at all hops → that inviter address
 * - Different inviters → address of inviter at lowest hop
 */
function computeDisplayInviter(
  address: string,
  nodes: Map<string, GraphNode>,
  hops: number[],
): string {
  if (hops.length === 0) return 'unknown'

  // If only hop-0, inviter is Armada
  if (hops.length === 1 && hops[0] === 0) return ROOT_ADDRESS

  // Collect all inviters across hops
  const allInviters = new Set<string>()
  for (const hop of hops) {
    const node = nodes.get(nodeKey(address, hop))
    if (node) {
      for (const inv of node.invitedBy) {
        allInviters.add(inv)
      }
    }
  }

  // Filter out the root sentinel
  const realInviters = [...allInviters].filter((inv) => inv !== ROOT_ADDRESS)

  if (realInviters.length === 0) return ROOT_ADDRESS
  if (realInviters.length === 1) return realInviters[0]

  // Multiple inviters — return inviter at lowest non-zero hop
  const sortedHops = [...hops].sort((a, b) => a - b)
  for (const hop of sortedHops) {
    const node = nodes.get(nodeKey(address, hop))
    if (node) {
      const nonRoot = node.invitedBy.filter((inv) => inv !== ROOT_ADDRESS)
      if (nonRoot.length > 0) return nonRoot[0]
    }
  }

  return realInviters[0]
}

/** Build address summaries from nodes */
function buildSummaries(nodes: Map<string, GraphNode>): Map<string, AddressSummary> {
  const byAddress = new Map<string, GraphNode[]>()
  for (const node of nodes.values()) {
    let list = byAddress.get(node.address)
    if (!list) {
      list = []
      byAddress.set(node.address, list)
    }
    list.push(node)
  }

  const summaries = new Map<string, AddressSummary>()
  for (const [address, addrNodes] of byAddress) {
    const hops = addrNodes.map((n) => n.hop).sort((a, b) => a - b)
    const perHop = new Map<number, bigint>()
    let totalCommitted = 0n
    for (const node of addrNodes) {
      perHop.set(node.hop, node.committed)
      totalCommitted += node.committed
    }

    const allocatedPerHop = new Map<number, bigint>()
    let hasAllocation = false
    for (const node of addrNodes) {
      if (node.acceptedUsdc !== null) {
        allocatedPerHop.set(node.hop, node.acceptedUsdc)
        hasAllocation = true
      }
    }

    // Collect every distinct inviter across the address's hop entries. A
    // multi-hop seed (hop-0 + hop-1) will end up with both the root sentinel
    // and the human inviter present so the NodeSphere can render both edges.
    const inviterSet = new Set<string>()
    for (const node of addrNodes) {
      for (const inv of node.invitedBy) inviterSet.add(inv)
    }

    summaries.set(address, {
      address,
      hops,
      totalCommitted,
      perHop,
      displayInviter: computeDisplayInviter(address, nodes, hops),
      allInviters: [...inviterSet],
      allocatedArm: hasAllocation ? addrNodes.reduce((sum, n) => sum + (n.allocatedArm ?? 0n), 0n) : null,
      refundUsdc: null,
      allocatedPerHop,
      armClaimed: false,
      refundClaimed: false,
      delegate: null,
    })
  }

  return summaries
}

/** Process a single event and mutate the graph state */
function applyEvent(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  event: CrowdfundEvent,
): void {
  switch (event.type) {
    case 'SeedAdded': {
      const seed = (event.args.seed as string).toLowerCase()
      const node = getOrCreateNode(nodes, seed, 0)
      node.invitesReceived += 1
      node.invitedBy.push(ROOT_ADDRESS)
      edges.push({
        fromAddress: ROOT_ADDRESS,
        fromHop: -1,
        toAddress: seed,
        toHop: 0,
      })
      break
    }

    case 'Invited': {
      const inviter = (event.args.inviter as string).toLowerCase()
      const invitee = (event.args.invitee as string).toLowerCase()
      const hop = Number(event.args.hop)
      const inviteeNode = getOrCreateNode(nodes, invitee, hop)
      inviteeNode.invitesReceived += 1
      inviteeNode.invitedBy.push(inviter)
      recomputeCommitted(inviteeNode)

      // Update inviter's invite counts at the hop above
      const inviterHop = hop - 1
      if (inviterHop >= 0) {
        const inviterNode = getOrCreateNode(nodes, inviter, inviterHop)
        inviterNode.invitesUsed += 1
        inviterNode.invitesAvailable = Math.max(0, inviterNode.invitesAvailable - 1)
      }

      edges.push({
        fromAddress: inviter,
        fromHop: inviterHop,
        toAddress: invitee,
        toHop: hop,
      })
      break
    }

    case 'LaunchTeamInvited': {
      const invitee = (event.args.invitee as string).toLowerCase()
      const hop = Number(event.args.hop)
      const inviteeNode = getOrCreateNode(nodes, invitee, hop)
      inviteeNode.invitesReceived += 1
      inviteeNode.invitedBy.push(ROOT_ADDRESS)
      recomputeCommitted(inviteeNode)

      edges.push({
        fromAddress: ROOT_ADDRESS,
        fromHop: -1,
        toAddress: invitee,
        toHop: hop,
      })
      break
    }

    case 'Committed': {
      const participant = (event.args.participant as string).toLowerCase()
      const hop = Number(event.args.hop)
      const amount = event.args.amount as bigint
      const node = getOrCreateNode(nodes, participant, hop)
      node.rawDeposited += amount
      recomputeCommitted(node)
      break
    }

    case 'AllocatedHop': {
      const participant = (event.args.participant as string).toLowerCase()
      const hop = Number(event.args.hop)
      const acceptedUsdc = event.args.acceptedUsdc as bigint
      const node = getOrCreateNode(nodes, participant, hop)
      node.acceptedUsdc = acceptedUsdc
      // Derive ARM from accepted USDC at 1:1 price (1 USDC = 1 ARM = 1e6 USDC → 1e18 ARM)
      node.allocatedArm = acceptedUsdc * 10n ** 12n
      break
    }

    case 'Allocated': {
      // Handled at summary level after all events
      break
    }

    case 'RefundClaimed': {
      // Handled at summary level
      break
    }

    default:
      // Other events (ArmLoaded, Finalized, Cancelled, InviteNonceRevoked,
      // UnallocatedArmWithdrawn) don't affect graph topology
      break
  }
}

/** Apply summary-level events (Allocated, RefundClaimed) to summaries */
function applySummaryEvents(
  summaries: Map<string, AddressSummary>,
  events: CrowdfundEvent[],
): void {
  for (const event of events) {
    if (event.type === 'Allocated') {
      const participant = (event.args.participant as string).toLowerCase()
      const summary = summaries.get(participant)
      if (summary) {
        summary.allocatedArm = event.args.armTransferred as bigint
        summary.refundUsdc = event.args.refundUsdc as bigint
        summary.delegate = (event.args.delegate as string).toLowerCase()
        summary.armClaimed = true
      }
    } else if (event.type === 'RefundClaimed') {
      const participant = (event.args.participant as string).toLowerCase()
      const summary = summaries.get(participant)
      if (summary) {
        summary.refundClaimed = true
        summary.refundUsdc = event.args.usdcAmount as bigint
      }
    }
  }
}

/** Drop redundant `Invited` events that are emitted alongside a
 *  `LaunchTeamInvited` event for the same on-chain action.
 *
 *  When the launch team calls `launchTeamInvite()`, the contract emits both:
 *    - `LaunchTeamInvited(invitee, hop)`           — the canonical event
 *    - `Invited(launchTeam, invitee, hop, 0)`      — leaked from internal _invite()
 *
 *  Without this dedup the graph would create a spurious node for the launch
 *  team's wallet at `hop - 1` (from the `Invited` handler) and a second
 *  inviter edge to the invitee — making the launch team show up as a
 *  participant in the network view and the participants table, instead of
 *  collapsing into the central Armada root. The pair always shares the same
 *  transaction hash, invitee, and hop, so that triple is the dedup key. */
function dropLaunchTeamInvitedShadows(events: CrowdfundEvent[]): CrowdfundEvent[] {
  const launchTeamKeys = new Set<string>()
  for (const e of events) {
    if (e.type !== 'LaunchTeamInvited') continue
    const invitee = String(e.args.invitee).toLowerCase()
    const hop = Number(e.args.hop)
    launchTeamKeys.add(`${e.transactionHash}:${invitee}:${hop}`)
  }
  if (launchTeamKeys.size === 0) return events
  return events.filter((e) => {
    if (e.type !== 'Invited') return true
    const invitee = String(e.args.invitee).toLowerCase()
    const hop = Number(e.args.hop)
    return !launchTeamKeys.has(`${e.transactionHash}:${invitee}:${hop}`)
  })
}

/** Build a complete graph from a sequence of events */
export function buildGraph(events: CrowdfundEvent[]): CrowdfundGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  const filteredEvents = dropLaunchTeamInvitedShadows(events)
  for (const event of filteredEvents) {
    applyEvent(nodes, edges, event)
  }

  const summaries = buildSummaries(nodes)
  applySummaryEvents(summaries, filteredEvents)

  // Keep the unfiltered event list on the returned graph so consumers like the
  // admin event log can still display the raw `Invited` shadow row — only the
  // graph topology drops it.
  return { nodes, edges, summaries, events }
}

/** Merge new events into an existing graph, returning a new graph */
export function mergeEvents(
  graph: CrowdfundGraph,
  newEvents: CrowdfundEvent[],
): CrowdfundGraph {
  // Clone nodes (shallow copy of each node)
  const nodes = new Map<string, GraphNode>()
  for (const [key, node] of graph.nodes) {
    nodes.set(key, { ...node, invitedBy: [...node.invitedBy] })
  }
  const edges = [...graph.edges]

  // Dedup against the combined history — handles the corner case where a
  // `LaunchTeamInvited` and its paired `Invited` arrive in separate polls.
  const allEvents = [...graph.events, ...newEvents]
  const filteredAll = dropLaunchTeamInvitedShadows(allEvents)
  const filteredAllKeys = new Set(
    filteredAll.map((e) => `${e.transactionHash}:${e.logIndex}`),
  )
  const newEventsFiltered = newEvents.filter((e) =>
    filteredAllKeys.has(`${e.transactionHash}:${e.logIndex}`),
  )
  for (const event of newEventsFiltered) {
    applyEvent(nodes, edges, event)
  }

  const summaries = buildSummaries(nodes)
  applySummaryEvents(summaries, filteredAll)

  return { nodes, edges, summaries, events: allEvents }
}

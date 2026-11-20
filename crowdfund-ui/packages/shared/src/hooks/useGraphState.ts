// ABOUTME: Derived graph state from crowdfund events.
// ABOUTME: Recomputes the invite graph whenever events change.

import { atom, useAtomValue } from 'jotai'
import { crowdfundEventsAtom } from './useContractEvents.js'
import { buildGraph } from '../lib/graph.js'
import { toPublicEvents } from '../lib/publicEvents.js'
import type { CrowdfundEvent } from '../lib/events.js'
import type { CrowdfundGraph, GraphNode, GraphEdge, AddressSummary } from '../lib/graph.js'

/** Derived atom — recomputes graph when events change */
export const crowdfundGraphAtom = atom<CrowdfundGraph>((get) => {
  const events = get(crowdfundEventsAtom)
  return buildGraph(events)
})

/** Participant-facing events: team inviter wallets hidden under profiles that hide them
 *  (see lib/publicEvents.ts); the raw events otherwise. */
export const publicCrowdfundEventsAtom = atom<CrowdfundEvent[]>((get) =>
  toPublicEvents(get(crowdfundEventsAtom)),
)

/** Participant-facing graph, built from the public events. The raw graph itself when nothing is
 *  hidden, so profiles that keep the real hop structure don't build it twice. */
export const publicCrowdfundGraphAtom = atom<CrowdfundGraph>((get) => {
  const events = get(crowdfundEventsAtom)
  const publicEvents = get(publicCrowdfundEventsAtom)
  return publicEvents === events ? get(crowdfundGraphAtom) : buildGraph(publicEvents)
})

export interface UseGraphStateResult {
  graph: CrowdfundGraph
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  summaries: Map<string, AddressSummary>
}

/** Hook for accessing the derived crowdfund graph state */
export function useGraphState(): UseGraphStateResult {
  const graph = useAtomValue(crowdfundGraphAtom)
  return {
    graph,
    nodes: graph.nodes,
    edges: graph.edges,
    summaries: graph.summaries,
  }
}

/** Hook for the participant-facing graph and events (see publicCrowdfundGraphAtom). Use for
 *  displays; use useGraphState for logic that needs the real structure (eligibility, invites). */
export function usePublicGraphState(): UseGraphStateResult & { events: CrowdfundEvent[] } {
  const graph = useAtomValue(publicCrowdfundGraphAtom)
  const events = useAtomValue(publicCrowdfundEventsAtom)
  return { graph, nodes: graph.nodes, edges: graph.edges, summaries: graph.summaries, events }
}

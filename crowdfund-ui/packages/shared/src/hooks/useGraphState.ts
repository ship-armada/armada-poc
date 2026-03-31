// ABOUTME: Derived graph state from crowdfund events.
// ABOUTME: Recomputes the invite graph whenever events change.

import { atom, useAtomValue } from 'jotai'
import { crowdfundEventsAtom } from './useContractEvents.js'
import { buildGraph } from '../lib/graph.js'
import type { CrowdfundGraph, GraphNode, GraphEdge, AddressSummary } from '../lib/graph.js'

/** Derived atom — recomputes graph when events change */
export const crowdfundGraphAtom = atom<CrowdfundGraph>((get) => {
  const events = get(crowdfundEventsAtom)
  return buildGraph(events)
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

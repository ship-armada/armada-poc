// ABOUTME: Barrel export for the shared crowdfund library.
// ABOUTME: Re-exports constants, event types, formatting, graph, RPC, and cache utilities.

export {
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
} from './lib/constants.js'
export type { HopConfig } from './lib/constants.js'

export type { CrowdfundEvent, CrowdfundEventType, RawLog } from './lib/events.js'
export { parseCrowdfundEvent, parseCrowdfundEvents } from './lib/events.js'

export {
  formatUsdc,
  formatUsdcPlain,
  parseUsdcInput,
  formatArm,
  truncateAddress,
  formatCountdown,
  hopLabel,
  phaseName,
  phaseColor,
} from './lib/format.js'

export { createProvider, fetchLogs, getBlockTimestamp } from './lib/rpc.js'

export type {
  GraphNode,
  GraphEdge,
  AddressSummary,
  CrowdfundGraph,
} from './lib/graph.js'
export { buildGraph, mergeEvents } from './lib/graph.js'

export {
  getCachedEvents,
  cacheEvents,
  getCachedENS,
  cacheENS,
  batchGetCachedENS,
  clearCache,
} from './lib/cache.js'

// Hooks
export {
  crowdfundEventsAtom,
  lastFetchedBlockAtom,
  eventsLoadingAtom,
  eventsErrorAtom,
  useContractEvents,
} from './hooks/useContractEvents.js'
export type { UseContractEventsConfig, UseContractEventsResult } from './hooks/useContractEvents.js'

export { crowdfundGraphAtom, useGraphState } from './hooks/useGraphState.js'
export type { UseGraphStateResult } from './hooks/useGraphState.js'

export {
  selectedAddressAtom,
  searchQueryAtom,
  useSelection,
} from './hooks/useSelection.js'
export type { UseSelectionResult } from './hooks/useSelection.js'

export { ensMapAtom, useENS } from './hooks/useENS.js'
export type { UseENSConfig, UseENSResult } from './hooks/useENS.js'

// Components
export { StatsBar } from './components/StatsBar.js'
export type { StatsBarProps, HopStatsData } from './components/StatsBar.js'

export { TableView } from './components/TableView.js'
export type { TableViewProps } from './components/TableView.js'

export { SearchBar } from './components/SearchBar.js'
export type { SearchBarProps } from './components/SearchBar.js'

export { NodeDetail } from './components/NodeDetail.js'
export type { NodeDetailProps } from './components/NodeDetail.js'

export { TreeView } from './components/TreeView.js'
export type { TreeViewProps } from './components/TreeView.js'

export type { TreeNode } from './lib/treeLayout.js'
export { graphToTree, filterTree } from './lib/treeLayout.js'

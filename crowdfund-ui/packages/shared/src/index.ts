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

export { estimateAllocation } from './lib/allocation.js'
export type { AllocationEstimate } from './lib/allocation.js'

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
  hoveredAddressAtom,
  useSelection,
} from './hooks/useSelection.js'
export type { UseSelectionResult } from './hooks/useSelection.js'

export { ensMapAtom, useENS } from './hooks/useENS.js'
export type { UseENSConfig, UseENSResult } from './hooks/useENS.js'

export { useAllocations } from './hooks/useAllocations.js'
export type { PrefetchedAllocation, UseAllocationsConfig } from './hooks/useAllocations.js'

// Components
export { StatsBar } from './components/StatsBar.js'
export type { StatsBarProps, HopStatsData, ConnectedSummary } from './components/StatsBar.js'

export { TableView } from './components/TableView.js'
export type { TableViewProps } from './components/TableView.js'

export { SearchBar } from './components/SearchBar.js'
export type { SearchBarProps } from './components/SearchBar.js'

export { NodeDetail } from './components/NodeDetail.js'
export type { NodeDetailProps } from './components/NodeDetail.js'

export { TreeView } from './components/TreeView.js'
export type { TreeViewProps } from './components/TreeView.js'

export { AppShell, NetworkBadge } from './components/AppShell.js'
export type { AppShellProps, AppShellNetwork } from './components/AppShell.js'

export { CrowdfundToaster } from './components/CrowdfundToaster.js'

export { LastTxChip } from './components/LastTxChip.js'

export { InfoTooltip } from './components/InfoTooltip.js'
export type { InfoTooltipProps } from './components/InfoTooltip.js'

export { ErrorAlert } from './components/ErrorAlert.js'
export type { ErrorAlertProps } from './components/ErrorAlert.js'

export { EmptyState } from './components/EmptyState.js'
export type { EmptyStateProps } from './components/EmptyState.js'

export { StaleDataBanner } from './components/StaleDataBanner.js'
export { useStaleDataBanner } from './hooks/useStaleDataBanner.js'
export type { StaleDataSignal, StaleReason } from './hooks/useStaleDataBanner.js'

export { ErrorBoundary, DefaultErrorFallback } from './components/ErrorBoundary.js'
export type {
  ErrorBoundaryProps,
  DefaultErrorFallbackProps,
} from './components/ErrorBoundary.js'

export { TOOLTIPS } from './lib/tooltips.js'
export type { TooltipKey } from './lib/tooltips.js'

export {
  lastTxAtom,
  useTxToast,
} from './hooks/useTxToast.js'
export type {
  LastTx,
  LastTxStatus,
  UseTxToastOptions,
  UseTxToastResult,
  TxToastHandle,
} from './hooks/useTxToast.js'

export type { TreeNode } from './lib/treeLayout.js'
export { graphToTree, filterTree } from './lib/treeLayout.js'

// Shared class-name helper
export { cn } from './lib/utils.js'

// shadcn/ui primitives — generated files under components/ui, edited in place
export { Alert, AlertTitle, AlertDescription } from './components/ui/alert.js'
export { Badge, badgeVariants } from './components/ui/badge.js'
export { Button, buttonVariants } from './components/ui/button.js'
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from './components/ui/card.js'
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.js'
export {
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
  useFormField,
} from './components/ui/form.js'
export { Input } from './components/ui/input.js'
export { Label } from './components/ui/label.js'
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from './components/ui/popover.js'
export { ScrollArea, ScrollBar } from './components/ui/scroll-area.js'
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.js'
export { Separator } from './components/ui/separator.js'
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './components/ui/sheet.js'
export { Skeleton } from './components/ui/skeleton.js'
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
} from './components/ui/tabs.js'
export { Toggle, toggleVariants } from './components/ui/toggle.js'
export { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group.js'
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from './components/ui/tooltip.js'

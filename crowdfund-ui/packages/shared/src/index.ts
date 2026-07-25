// ABOUTME: Barrel export for the shared crowdfund library.
// ABOUTME: Re-exports constants, event types, formatting, graph, RPC, and cache utilities.

export {
  CROWDFUND_CONSTANTS,
  CROWDFUND_PROFILE,
  HOP_CONFIGS,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
} from './lib/constants.js'
export type { HopConfig, CrowdfundConstants, CrowdfundProfile } from './lib/constants.js'

export type { CrowdfundEvent, CrowdfundEventType, RawLog } from './lib/events.js'
export { parseCrowdfundEvent, parseCrowdfundEvents } from './lib/events.js'

export {
  formatUsdc,
  formatUsdcPlain,
  parseUsdcInput,
  formatArm,
  truncateAddress,
  formatCountdown,
  formatTimeLeft,
  formatTimeLeftDetail,
  hopLabel,
  phaseName,
  phaseColor,
} from './lib/format.js'

export {
  sanitizeAmountInput,
  hasActiveAmount,
  parseActiveAmount,
} from './lib/amountInput.js'

export {
  MOBILE_LAYOUT_MAX_WIDTH_PX,
  LAPTOP_LAYOUT_MAX_WIDTH_PX,
  SHORT_VIEWPORT_MAX_HEIGHT_PX,
} from './lib/viewportBreakpoints.js'

export {
  ADDRESS_INPUT_MAX_LENGTH,
  sanitizeAddressInput,
  isHexAddressFormat,
  tryGetChecksumAddress,
  isValidEnsName,
} from './lib/addressInput.js'

export { estimateAllocation, estimateUserArmAllocation } from './lib/allocation.js'
export type { AllocationEstimate, HopAllocationStats, UserHopPosition } from './lib/allocation.js'

export {
  computeSelfFillPlan,
  fetchSelfFillState,
  encodeSelfFillCalls,
} from './lib/selfFillPlan.js'
export type {
  SelfFillHopState,
  SelfFillState,
  SelfFillInvite,
  SelfFillCommit,
  SelfFillPlan,
  ComputeSelfFillOptions,
} from './lib/selfFillPlan.js'

export {
  resolveNetworkMode,
  isLocalNetwork,
  chainIdForMode,
  networkLabelForChainId,
  resolveHubRpcUrls,
  resolveIndexerUrl,
  resolveDeploymentFileName,
  pollIntervalForMode,
  maxBlockRangeForMode,
  confirmationsForMode,
  explorerUrlForMode,
  assertDeploymentChainId,
  assertExpectedAddress,
  getNetworkMode,
  isLocalMode,
  getHubChainId,
  getHubNetworkLabel,
  getHubRpcUrl,
  getHubRpcUrls,
  getIndexerUrl,
  getDeploymentFileName,
  getPollIntervalMs,
  getMaxBlockRange,
  getTxConfirmations,
  getExplorerUrl,
  getExpectedCrowdfundAddress,
} from './lib/network.js'
export type { NetworkMode, NetworkEnv } from './lib/network.js'

export { createProvider, fetchLogs, getBlockTimestamp } from './lib/rpc.js'
export {
  aggregate3,
  getMulticall3Contract,
  MULTICALL3_ADDRESS,
  type AggregateCall,
  type AggregateResult,
} from './lib/multicall3.js'

export { fetchIndexedEventsSnapshot, fetchIndexerHealth, reviveIndexedEvent } from './lib/indexer.js'
export type {
  IndexedEventsSnapshot,
  IndexedSnapshotMetadata,
  IndexerHealth,
  IndexerHealthStatus,
} from './lib/indexer.js'

export type {
  GraphNode,
  GraphEdge,
  AddressSummary,
  CrowdfundGraph,
} from './lib/graph.js'
export { buildGraph, mergeEvents } from './lib/graph.js'

export { generateMockGraph } from './lib/mockGraph.js'
export type { MockGraphOptions } from './lib/mockGraph.js'

export { IdenticonSvg } from './components/IdenticonSvg.js'
export type { IdenticonSvgProps } from './components/IdenticonSvg.js'

export { GraphLegend } from './components/GraphLegend.js'
export type { GraphLegendProps } from './components/GraphLegend.js'

export {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from './components/ui/hover-card.js'

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
export type { ReceiptLogLike } from './hooks/useContractEvents.js'

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

export { useContractState } from './hooks/useContractState.js'
export type { ContractState } from './hooks/useContractState.js'

// Components
export { StatsBar } from './components/StatsBar.js'
export type { StatsBarProps, HopStatsData, UserAllocation } from './components/StatsBar.js'

export { TableView } from './components/TableView.js'
export type { TableViewProps } from './components/TableView.js'

export { SearchBar } from './components/SearchBar.js'
export type { SearchBarProps } from './components/SearchBar.js'

export { NodeDetail } from './components/NodeDetail.js'
export type { NodeDetailProps } from './components/NodeDetail.js'

export { TreeView } from './components/TreeView.js'
export type { TreeViewProps } from './components/TreeView.js'

export type { RadialNode, RadialEdge, RadialGraph, AngleInfo } from './lib/radialLayout.js'
export { buildRadialGraph, computeAngleMap } from './lib/radialLayout.js'

export {
  GRAPH_HOP_NODE_COLORS,
  graphHopColorToCss,
  heroListHopColor,
  hopPillDotColor,
} from './lib/graphHopColors.js'
export type { GraphHopNodeKind } from './lib/graphHopColors.js'

export { AppShell } from './components/AppShell.js'
export type { AppShellProps, AppShellNetwork } from './components/AppShell.js'

export { SplashBackdrop } from './components/SplashBackdrop.js'
export type { SplashBackdropProps } from './components/SplashBackdrop.js'

export { AppHeader } from './components/AppHeader.js'
export type { AppHeaderProps, AppHeaderNetwork } from './components/AppHeader.js'

export { HopPill } from './components/HopPill/index.js'
export type { HopPillProps, HopVariant } from './components/HopPill/index.js'

export { HopStatCard } from './components/HopStatCard/index.js'
export type { HopStatCardProps, HopStatAccent } from './components/HopStatCard/index.js'

export { JoinButton } from './components/JoinButton/index.js'
export type { JoinButtonProps } from './components/JoinButton/index.js'

export { ParticipantsTable } from './components/ParticipantsTable/index.js'
export type {
  ParticipantsTableProps,
  ParticipantsTableFilter,
  ParticipantRow,
} from './components/ParticipantsTable/index.js'

export { HeroParticipantsPanel, HeroParticipantsMobileStack } from './components/HeroParticipantsPanel/index.js'
export type {
  HeroParticipantsPanelProps,
  HeroParticipantsMobileStackProps,
  HeroHopFilter,
  HeroParticipant,
} from './components/HeroParticipantsPanel/index.js'

export { NodeSphere } from './components/NodeSphere/index.js'
export type { NodeSphereProps, PinnedNode } from './components/NodeSphere/index.js'

export { CrowdfundExperience } from './components/CrowdfundExperience/index.js'
export type {
  CrowdfundExperienceProps,
  CrowdfundView,
  CrowdfundInviteSlotConfig,
  CrowdfundInviteSlotSection,
  CrowdfundExperienceLiveData,
  CrowdfundExperienceMyPositionData,
  CrowdfundExperienceHopPosition,
} from './components/CrowdfundExperience/index.js'

export { Participate } from './components/Participate/index.js'
export type { ParticipateProps } from './components/Participate/index.js'

// Hero media assets — re-exported as URL strings so consuming apps can pass
// them to <Participate imageSrc=… videoSrc=… /> (e.g. the committer mobile menu).
export { default as fleetPng } from './assets/fleet.png'
export { default as fleetMp4 } from './assets/fleet.mp4'

export {
  MyPosition,
  MyPositionHero,
  MyPositionSplit,
  COMMITTED as MY_POSITION_COMMITTED,
  CAP as MY_POSITION_CAP,
  ARM_ALLOCATION as MY_POSITION_ARM_ALLOCATION,
  FILL_PCT as MY_POSITION_FILL_PCT,
  formatUsdcCommitted,
  formatArmAllocation,
  GRAPH_SEED as MY_POSITION_GRAPH_SEED,
  GRAPH_PARTICIPANTS as MY_POSITION_GRAPH_PARTICIPANTS,
  DEMO_WALLET as MY_POSITION_DEMO_WALLET,
  DEMO_WALLET_DISPLAY as MY_POSITION_DEMO_WALLET_DISPLAY,
  DEMO_SLOTS as MY_POSITION_DEMO_SLOTS,
  buildInvitePinnedNodes,
} from './components/MyPosition/index.js'
export type { MyPositionProps, MyPositionSplitProps } from './components/MyPosition/index.js'

export {
  generateCrowdfund,
  toDashboardParticipants,
  toHeroParticipants,
  toDashboardParticipantsFromGraph,
  toParticipantsTableRows,
} from './lib/mockParticipants.js'
export type {
  ScenarioParticipants,
  Hop,
  HeroParticipantRow,
  DashboardParticipant,
  ParticipantsTableRow,
  Participant,
  CrowdfundSnapshot,
} from './lib/mockParticipants.js'

export {
  Step0Invite,
  Step1Wallet,
  Step1Connect,
  Step1SwitchNetwork,
  Step1WalletNotWhitelisted,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  ParticipateFlowModal,
  ParticipateFlowInviteSlots,
  MaxOutBanner,
  INVITE_LINK_STEPS,
  CROWDFUND_MODAL_STEPS,
} from './components/ParticipateFlow/index.js'
export type {
  Step0InviteProps,
  Step2CommitHopRow,
  Step2MaxOutOption,
  Step3ReviewHopCommit,
  Step4ApproveProps,
  Step4Transaction,
  Step4TransactionStatus,
  ParticipateFlowModalProps,
  ParticipateFlowInviteSlotsProps,
  ParticipateStepsStatus,
  ParticipateStepBarProps,
} from './components/ParticipateFlow/index.js'

export {
  InviteSlots,
  SlotCard,
  truncateAddress as inviteSlotTruncateAddress,
} from './components/InviteFlow/index.js'
export type { SlotData, SlotStatus, SlotCardEnsResult } from './components/InviteFlow/index.js'

export { CrowdfundToaster } from './components/CrowdfundToaster.js'

export { CopyToast } from './components/CopyToast.js'

export { LastTxChip } from './components/LastTxChip.js'

export { InfoTooltip } from './components/InfoTooltip.js'
export type { InfoTooltipProps } from './components/InfoTooltip.js'

export { ErrorAlert } from './components/ErrorAlert.js'
export type { ErrorAlertProps } from './components/ErrorAlert.js'

export { EmptyState } from './components/EmptyState.js'
export type { EmptyStateProps } from './components/EmptyState.js'

export { AmountInput } from './components/AmountInput.js'
export type { AmountInputProps, AmountCeiling } from './components/AmountInput.js'

export { Stepper, StepFooter } from './components/Stepper.js'
export type {
  StepperProps,
  StepperStep,
  StepFooterProps,
} from './components/Stepper.js'

export { TxStatusPipeline } from './components/TxStatusPipeline.js'
export type {
  TxStatusPipelineProps,
  TxPipelineRow,
  TxPipelineStatus,
} from './components/TxStatusPipeline.js'

export { LifecycleBanner } from './components/LifecycleBanner.js'
export type {
  LifecycleBannerProps,
  LifecycleStage,
} from './components/LifecycleBanner.js'

export { WhatsNextCard } from './components/WhatsNextCard.js'
export type {
  WhatsNextCardProps,
  WhatsNextStep,
  WhatsNextStepStatus,
} from './components/WhatsNextCard.js'

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

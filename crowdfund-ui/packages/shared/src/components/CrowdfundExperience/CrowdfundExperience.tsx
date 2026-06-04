// ABOUTME: Ported from the armada-crowdfund mockup (components/CrowdfundExperience/CrowdfundExperience.tsx); designer's '/fleet.png' + '/fleet.mp4' public-folder paths replaced with ESM asset imports so the assets ship with crowdfund-shared.
// ABOUTME: Header rendering is also exposed via a slot prop (default falls back to @armada/ui's Header) so consuming apps render only one chrome instead of two; view is optionally controllable from outside to keep consumer page state in sync.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { ensMapAtom } from '../../hooks/useENS'
import { Header } from '@armada/ui'
import { Progress } from '@armada/ui'
import { Participate } from '../Participate/Participate'
import { HeroParticipantsPanel, type HeroParticipant } from '../HeroParticipantsPanel'
import { Tag } from '@armada/ui'
import { Tooltip } from '@armada/ui'
import SlotCard from '../InviteFlow/screens/SlotCard'
import {
  ARM_ALLOCATION,
  CAP,
  COMMITTED,
  DEMO_SLOTS,
  DEMO_WALLET,
  DEMO_WALLET_DISPLAY,
  FILL_PCT,
  formatArmAllocation,
  formatUsdcCommitted,
} from '../MyPosition/myPositionDemo'
import { NodeSphere } from '../NodeSphere/NodeSphere'
import { hopPillDotColor } from '../../lib/graphHopColors'
import { CROWDFUND_CONSTANTS } from '../../lib/constants'
import {
  generateCrowdfund,
  toDashboardParticipants,
  toHeroParticipants,
  type DashboardParticipant,
} from '../../lib/mockParticipants'
import { HeroLoadingSkeleton } from './HeroLoadingSkeleton'
import { MyPositionEmptyState } from './MyPositionEmptyState'
import fleetPng from '../../assets/fleet.png'
import fleetMp4 from '../../assets/fleet.mp4'
import heroStyles from './Hero.module.css'
import mpStyles from '../MyPosition/MyPositionHero.module.css'
import shellStyles from './CrowdfundExperience.module.css'

export type CrowdfundView = 'crowdfund' | 'myposition'

/**
 * Controlled invite-slot rendering for the MyPosition view's "Your invites" card.
 * Pass a populated config to render real invite-slot rows + wire real handlers;
 * omit to keep the internal demo behavior (used by the showcase / mock previews).
 */
export interface CrowdfundInviteSlotConfig {
  slots: import('../InviteFlow/screens/SlotCard').SlotData[]
  copiedId: number | null
  loadingId: number | null
  onGenerateLink: (slotId: number) => Promise<void>
  onCopy: (slotId: number, link: string) => void
  onRevoke: (slotId: number) => void
  onInviteOnchain: (
    slotId: number,
    address: string,
    ensName?: string,
  ) => Promise<void>
  /**
   * Real ENS resolver forwarded to each `<SlotCard resolveEns={…} />`. Omit to
   * let SlotCard use its internal mock (showcase / preview only — returns a
   * random address per name).
   */
  resolveEns?: (
    input: string,
  ) => Promise<import('../InviteFlow/screens/SlotCard').SlotCardEnsResult>
}

/** One hop's worth of invite slots, paired with its display label / color +
 *  a self-contained `CrowdfundInviteSlotConfig` that handles only that hop's
 *  slot interactions. Multi-hop wallets render multiple sections stacked; the
 *  section header (label + slot count + colored dot) is suppressed when there
 *  is only one section so single-hop UX is unchanged. */
export interface CrowdfundInviteSlotSection {
  /** Source hop the invites come from (slot generates an invite at `hop + 1`). */
  hop: 0 | 1 | 2
  /** Display label — 'SEED' / 'HOP-1' / 'HOP-2'. */
  hopLabel: string
  /** Dot color from the canonical hop palette (`graphHopColors.ts`). */
  hopColor: string
  /** Total slot budget for this hop (sum of available + used). */
  totalSlots: number
  /** Per-hop slot list + handlers. Slot IDs are namespaced by hop, so the
   *  shared `copiedId` / `loadingId` numbers don't collide across sections. */
  config: CrowdfundInviteSlotConfig
}

/**
 * Live crowdfund data shape. Discriminated by `status` so callers can express
 * "still fetching events" (`loading`) and "events fetched, but zero
 * participants" (`ready` with empty `dashRows`) as distinct UI states — the
 * first shows a skeleton, the second falls through to the existing empty-state
 * CTAs already baked into `HeroParticipantsPanel` / `ParticipantsTable`.
 *
 * When the prop is omitted entirely, `CrowdfundExperience` falls back to the
 * deterministic mock snapshot — the showcase / `?design=v1` preview behavior.
 */
export type CrowdfundExperienceLiveData =
  | { status: 'loading' }
  | {
      status: 'ready'
      dashRows: DashboardParticipant[]
      totalCommitted: number
      /** Countdown label shown on the Progress card (e.g. "6 DAYS LEFT").
       *  Pass `null` to suppress the tag once the window has ended — the
       *  Progress primitive hides it rather than rendering a stale countdown.
       *  Omit entirely to fall back to the primitive's mockup default. */
      daysLeftLabel?: string | null
      /** Lifecycle status pill label (e.g. 'ACTIVE', 'CLOSED', 'FINALIZED').
       *  Omit to fall back to the primitive's 'ACTIVE' default. */
      saleStatusLabel?: string
      /** Tag dot color paired with `saleStatusLabel`. */
      saleStatusDot?: 'active' | 'warning' | 'error' | 'neutral' | 'lavender'
    }

/**
 * Live "My Position" data for the connected wallet. Discriminated by `status`
 * so callers can express the three real-world cases distinctly:
 *
 * - `disconnected` — no wallet connected. Renders a "Connect wallet" CTA.
 * - `no-position` — wallet connected but hasn't committed / hasn't been
 *    invited. Renders a "Participate to claim a hop" CTA. `walletDisplay`
 *    populates the wallet tag so the user still sees their address.
 * - `ready` — wallet connected with a real position. Renders live numbers
 *    and feeds `walletAddress` into the NodeSphere so lock/focus operates
 *    on the user's real graph node.
 *
 * Omit the prop entirely to fall through to the demo constants from
 * `myPositionDemo.ts` (showcase / `?design=v1` preview behavior).
 */
/** A single hop-position slice for a wallet — committed / cap / invite-slot
 *  budget at one hop. Multi-hop wallets have several. The data layer's
 *  `useEligibility` hook already produces this shape (modulo the `cap` field
 *  name); the renderer consumes it via `CrowdfundExperienceMyPositionData`. */
export interface CrowdfundExperienceHopPosition {
  hop: 0 | 1 | 2
  /** USDC committed at this hop (6 decimals). */
  committed: bigint
  /** USDC cap at this hop (6 decimals — `effectiveCap` from useEligibility).
   *  Equal to `invitesReceived * hop-base-cap`, so a wallet invited twice to
   *  the same hop has double the per-hop cap. */
  cap: bigint
  /** Number of times this wallet was invited at this hop. >1 when multiple
   *  seeds / inviters routed the wallet to the same hop; drives the `xN`
   *  suffix on the meta-row hop chip. */
  invitesReceived: number
  /** Remaining invite slots the user can hand out from this hop. */
  invitesAvailable: number
  /** Invite slots already consumed from this hop. */
  invitesUsed: number
}

export type CrowdfundExperienceMyPositionData =
  | { status: 'disconnected' }
  | { status: 'no-position'; walletDisplay: string }
  | {
      status: 'ready'
      /** Full 0x40-hex address — passed to NodeSphere for lock/focus. */
      walletAddress: string
      /** Truncated display form — drives the wallet `<Tag>` label. */
      walletDisplay: string
      /** Primary hop = lowest hop the user is eligible at. Drives the
       *  `HOP-N` / `SEED` tag label and the legacy single-hop stat block
       *  (until per-hop rendering lands in step 2). New multi-hop UI
       *  should iterate `positions` instead of reading these scalar
       *  fields. */
      hop: 0 | 1 | 2
      /** USDC committed at the primary hop (6 decimals). */
      committedUsdc: bigint
      /** USDC cap at the primary hop (6 decimals — `effectiveCap`). */
      capUsdc: bigint
      /** Estimated ARM allocation across every eligible hop (18 decimals). */
      armAllocation: bigint
      /** All hops this wallet is eligible at, ordered by hop ascending.
       *  Single-hop wallets carry one entry; multi-hop carry two or three.
       *  `positions[0]` is always equivalent to the legacy `hop` /
       *  `committedUsdc` / `capUsdc` scalars — those stay populated as a
       *  back-compat shim while consumers migrate. */
      positions: ReadonlyArray<CrowdfundExperienceHopPosition>
      /** True once the user's `claim()` has been executed (read from the graph
       *  summary, which sets it on the `Allocated` event). Surfaces a
       *  "CLAIMED" tag in the meta row. */
      armClaimed?: boolean
      /** True when the sale has been finalized (contract phase === 1). Flips
       *  the ARM allocation tooltip from "Estimated · pending finalization" to
       *  "Available for claim", since post-finalize the amount is no longer an
       *  estimate. */
      finalized?: boolean
      /** True when the sale's outcome is (or will be) a refund — either
       *  contract `refundMode === true` (post-finalize, below-min) or
       *  cancelled (`phase === 2`), or pre-finalize but the window has closed
       *  with `cappedDemand < MIN_SALE`. When set, the stat block swaps from
       *  "ARM allocation" to "USDC refund" and the tooltip + CLAIMED tag pivot
       *  to refund semantics. */
      refundMode?: boolean
      /** USDC refund amount (6 decimals) to display when `refundMode` is true.
       *  Post-claim: actual `refundUsdc` from `RefundClaimed`. Pre-claim:
       *  the user's total committed USDC (full refund in refund mode). */
      refundUsdc?: bigint
      /** True once the user's `claimRefund()` has been executed (read from
       *  the graph summary, set on the `RefundClaimed` event). Surfaces the
       *  "CLAIMED" tag in the meta row when `refundMode` is true. */
      refundClaimed?: boolean
      /** True when the sale was cancelled by the security council (contract
       *  `phase === 2`). Distinguishes a cancellation from a below-min refund:
       *  cancellation is immediate, has no `finalize()` step, and warrants
       *  different tooltip / claim-flow copy. Implies `refundMode === true`. */
      cancelled?: boolean
    }

const HOP_TAG_LABELS = ['SEED', 'HOP-1', 'HOP-2'] as const

function usdcBigintToUsdNumber(value: bigint): number {
  return Number(value / 1_000_000n)
}

function armBigintToArmNumber(value: bigint): number {
  // Integer ARM count is fine for the rendered display (no fractional ARM in
  // the My Position card). `Number(big / 10n**18n)` stays exact up to
  // Number.MAX_SAFE_INTEGER (~9 quadrillion ARM) — well above the sale size.
  return Number(value / 1_000_000_000_000_000_000n)
}

function computeFillPct(committed: bigint, cap: bigint): number {
  if (cap <= 0n) return 0
  // Multiply before dividing to keep one decimal of precision (basis points).
  const bps = (committed * 10_000n) / cap
  return Math.min(100, Number(bps) / 100)
}

export interface CrowdfundExperienceProps {
  /** Initial view when uncontrolled. Ignored if `view` is provided. */
  initialView?: CrowdfundView
  /**
   * Controlled view. When provided, internal state syncs to this value and
   * `onViewChange` fires after the panel transition completes. Omit for the
   * default uncontrolled behavior (e.g. standalone mockup preview).
   */
  view?: CrowdfundView
  /** Fires after a panel transition resolves to the new view. */
  onViewChange?: (next: CrowdfundView) => void
  /**
   * Header slot. When provided, replaces the default @armada/ui `<Header>`
   * that CrowdfundExperience would otherwise render. Pass the consumer's app
   * chrome here so the page renders one — not two — headers.
   *
   * The slotted node is rendered at the same DOM position as the default
   * Header. Wallet pill, nav active state, and nav click handlers become the
   * consumer's responsibility. To drive view transitions from a slotted
   * header, set `view` from the parent in response to nav clicks.
   *
   * Pass `null` to render no header at all (e.g. when the consumer wraps
   * CrowdfundExperience in its own AppShell that already renders a header).
   */
  header?: ReactNode
  /**
   * Controlled per-hop invite-slot sections for the MyPosition view's "Your
   * invites" card. One section per eligible hop; single-hop wallets pass an
   * array of length 1 and the card renders without a hop header. Omit to
   * keep the showcase / preview demo behavior (which uses internal mock
   * `DEMO_SLOTS` and stubbed handlers).
   */
  inviteSlotSections?: ReadonlyArray<CrowdfundInviteSlotSection>
  /**
   * Live crowdfund data. When provided, replaces the internal mock snapshot
   * with real graph data (or renders a loading skeleton while events are
   * still being fetched). See `CrowdfundExperienceLiveData` for the shape.
   * Omit to keep the showcase / preview mock behavior.
   */
  liveData?: CrowdfundExperienceLiveData
  /**
   * Live My Position data for the connected wallet. See
   * `CrowdfundExperienceMyPositionData` for the discriminated union covering
   * disconnected / no-position / ready. Omit to keep the showcase demo path.
   */
  myPositionData?: CrowdfundExperienceMyPositionData
  /**
   * Fires when the disconnected-state's "Connect wallet" CTA is clicked.
   * When omitted, the empty state renders text-only guidance pointing the
   * user to the header's connect button.
   */
  onConnectWallet?: () => void
  /**
   * Fires when the no-position-state's "Participate" CTA is clicked. When
   * omitted, the empty state renders text-only guidance.
   */
  onParticipate?: () => void
  /**
   * When `false`, hides every surface whose underlying contract call requires
   * an open commit window: the Crowdfund hero's `<Participate>` card,
   * the default header's "Participate" gradient button, and the MyPosition
   * view's "Your invites" card. Set this to the consumer's `windowOpen`
   * signal so the UI mirrors the chain's post-window-close gating. Defaults
   * to `true` — preserves showcase / preview behavior.
   */
  participationEnabled?: boolean
  /** Forwarded to `NodeSphere` — block-explorer base URL for the selected-node
   *  tooltip's address link. Omit in local mode. */
  etherscanBaseUrl?: string
}

function readInitialView(prop?: CrowdfundView): CrowdfundView {
  if (prop) return prop
  if (typeof window !== 'undefined') {
    const v = new URLSearchParams(window.location.search).get('view')
    if (v === 'myposition') return 'myposition'
  }
  return 'crowdfund'
}

const PANEL_EXIT_MS = 240
const PANEL_GAP_MS = 90
const PANEL_ENTER_MS = 240

type PanelPhase = 'idle' | 'exit' | 'enter'

function layerClass(visible: boolean, motionReady: boolean, animate: boolean) {
  return [
    shellStyles.cornerLayer,
    visible ? shellStyles.cornerLayerVisible : shellStyles.cornerLayerHidden,
    !motionReady && shellStyles.cornerLayerMotionOff,
    motionReady && !animate && shellStyles.cornerLayerNoMotion,
  ]
    .filter(Boolean)
    .join(' ')
}

function panelVisible(view: CrowdfundView, layer: CrowdfundView, phase: PanelPhase) {
  if (phase === 'idle') return view === layer
  if (phase === 'exit') return false
  return view === layer
}

function panelAnimates(view: CrowdfundView, layer: CrowdfundView, phase: PanelPhase, motionReady: boolean) {
  if (!motionReady || phase === 'idle') return motionReady
  return view === layer
}

export function CrowdfundExperience({
  initialView,
  view: controlledView,
  onViewChange,
  header,
  inviteSlotSections,
  liveData,
  myPositionData,
  onConnectWallet,
  onParticipate,
  participationEnabled = true,
  etherscanBaseUrl,
}: CrowdfundExperienceProps) {
  // Single seed per CrowdfundExperience mount drives the deterministic mock
  // generator. The branch port replaced the discrete `0 / 3 / 4 / 5 / 30 / 800`
  // scenario picker with a fixed-shape realistic dataset (~1100 entries,
  // 100 seeds → 300 hop-1 → 600 hop-2 + multi-hop self-invites). Consumers
  // wanting a smaller / empty preview can override via `liveData`.
  const seedRef = useRef<number | null>(null)
  if (seedRef.current === null) {
    seedRef.current = Math.floor(Math.random() * 1_000_000_000)
  }
  const snapshot = useMemo(() => generateCrowdfund(seedRef.current!), [])

  const [view, setView] = useState<CrowdfundView>(() =>
    readInitialView(controlledView ?? initialView),
  )
  const [graphMode, setGraphMode] = useState<CrowdfundView>(() =>
    readInitialView(controlledView ?? initialView),
  )
  const [panelPhase, setPanelPhase] = useState<PanelPhase>('idle')
  const [motionReady, setMotionReady] = useState(false)
  const panelTransitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Live data takes precedence when supplied. `loading` mode renders a
  // skeleton in place of the Progress + HeroParticipantsPanel and feeds an
  // empty dataset to the NodeSphere so its built-in empty-scenario ghosts
  // show through. `ready` mode swaps in the real graph rows. When the prop
  // is omitted entirely we fall back to the mock snapshot (preview / showcase).
  const isLiveLoading = liveData?.status === 'loading'
  const liveReady = liveData?.status === 'ready' ? liveData : null

  const committedAmount = liveReady ? liveReady.totalCommitted : snapshot.totalCommitted

  const dashRows = useMemo<DashboardParticipant[]>(() => {
    if (isLiveLoading) return []
    if (liveReady) return liveReady.dashRows
    return toDashboardParticipants(snapshot)
  }, [isLiveLoading, liveReady, snapshot])
  // Reverse-resolve ENS names for the address list. `useENS` is mounted in
  // the consuming app (committer / observer) and feeds `ensMapAtom`; here
  // we just read the cached map and inject the resolved name onto each
  // participant. Rows without a resolved name fall back to the truncated
  // address in `HeroParticipantsPanel`. Atom updates re-render the panel
  // naturally as resolutions land.
  const ensMap = useAtomValue(ensMapAtom)
  const participants = useMemo<HeroParticipant[]>(() => {
    const base = toHeroParticipants(dashRows) as HeroParticipant[]
    if (ensMap.size === 0) return base
    return base.map((p) => {
      const name = ensMap.get(p.address.toLowerCase())
      return name ? { ...p, displayName: name } : p
    })
  }, [dashRows, ensMap])

  // Derived MyPosition display values. The `ready` status produces live
  // numbers; `disconnected` / `no-position` short-circuit into the
  // MyPositionEmptyState render path below. Omitting the prop entirely keeps
  // the demo constants (showcase / preview path).
  const myPositionReady = myPositionData?.status === 'ready' ? myPositionData : null
  const myPositionEmptyKind: 'disconnected' | 'no-position' | null =
    myPositionData?.status === 'disconnected'
      ? 'disconnected'
      : myPositionData?.status === 'no-position'
        ? 'no-position'
        : null
  const myPositionWalletAddress = myPositionReady?.walletAddress
    ?? (myPositionData ? undefined : DEMO_WALLET)
  const myPositionWalletDisplay =
    myPositionReady?.walletDisplay
    ?? (myPositionData?.status === 'no-position'
      ? myPositionData.walletDisplay
      : myPositionData
        ? undefined
        : DEMO_WALLET_DISPLAY)
  // Per-hop chips rendered in the meta row. Multi-hop wallets get one chip
  // per distinct hop, with an `xN` suffix when they were invited to the same
  // hop multiple times (e.g. two seed inviters → "SEED x2"). Single-hop
  // wallets still get just one chip.
  const myPositionHopChips = useMemo(() => {
    const colorFor = (hop: 0 | 1 | 2) =>
      hop === 0
        ? hopPillDotColor('seed')
        : hop === 1
          ? hopPillDotColor('hop-1')
          : hopPillDotColor('hop-2')
    if (!myPositionReady) {
      return [
        { key: 'demo', label: <>HOP-1</> as ReactNode, dotColor: hopPillDotColor('hop-1') },
      ]
    }
    return myPositionReady.positions.map((pos) => {
      const base = HOP_TAG_LABELS[pos.hop]
      const label: ReactNode =
        pos.invitesReceived > 1 ? (
          <>
            {base}
            <span className={mpStyles.hopChipMultiplier}>x{pos.invitesReceived}</span>
          </>
        ) : (
          base
        )
      return { key: `hop-${pos.hop}`, label, dotColor: colorFor(pos.hop) }
    })
  }, [myPositionReady])
  // Cross-hop totals — `committed` / `cap` collapse the user's full footprint
  // into one stat block + one fill bar. A wallet with `SEED ($1k cap)` plus a
  // `HOP-1 x2 ($2k cap)` position shows $3k cap and the sum of commitments.
  const myPositionCommittedUsd = myPositionReady
    ? usdcBigintToUsdNumber(
        myPositionReady.positions.reduce((sum, p) => sum + p.committed, 0n),
      )
    : COMMITTED
  const myPositionCapUsd = myPositionReady
    ? usdcBigintToUsdNumber(
        myPositionReady.positions.reduce((sum, p) => sum + p.cap, 0n),
      )
    : CAP
  const myPositionFillPct = myPositionReady
    ? computeFillPct(
        myPositionReady.positions.reduce((sum, p) => sum + p.committed, 0n),
        myPositionReady.positions.reduce((sum, p) => sum + p.cap, 0n),
      )
    : FILL_PCT
  const myPositionArmNumber = myPositionReady
    ? armBigintToArmNumber(myPositionReady.armAllocation)
    : ARM_ALLOCATION
  const myPositionArmClaimed = myPositionReady ? !!myPositionReady.armClaimed : false
  const myPositionFinalized = myPositionReady ? !!myPositionReady.finalized : false
  const myPositionRefundMode = myPositionReady ? !!myPositionReady.refundMode : false
  const myPositionRefundClaimed = myPositionReady ? !!myPositionReady.refundClaimed : false
  const myPositionCancelled = myPositionReady ? !!myPositionReady.cancelled : false
  const myPositionRefundUsd = myPositionReady
    ? usdcBigintToUsdNumber(myPositionReady.refundUsdc ?? 0n)
    : 0
  // Refund-mode reuses the same "CLAIMED" tag slot; the source flag differs.
  const myPositionTerminalClaimed = myPositionRefundMode
    ? myPositionRefundClaimed
    : myPositionArmClaimed
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState<'all' | 'seed' | 'hop1' | 'hop2' | 'multi'>('all')
  const [participantsListOpen, setParticipantsListOpen] = useState(false)
  const [holdColumnExpanded, setHoldColumnExpanded] = useState(false)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)
  // My Position invites card — open by default; user toggles collapse/expand.
  const [invitesExpanded, setInvitesExpanded] = useState<boolean>(true)
  const invitesListId = useId()

  const participantsPanelRef = useRef<HTMLDivElement | null>(null)
  const leftStackRef = useRef<HTMLDivElement | null>(null)

  const HERO_EXPAND_MS = 380
  const isCrowdfund = view === 'crowdfund'
  const isMyPosition = view === 'myposition'
  const isGraphCrowdfund = graphMode === 'crowdfund'
  const isGraphMyPosition = graphMode === 'myposition'
  // NodeSphere accepts a discrete `0 | 3 | 4 | 5 | 30 | 800` for its internal
  // node generation. Until Phase 4b.1 ports the upgraded NodeSphere (which
  // renders pinnedNodes directly and drops scenarioParticipants), pass 800 so
  // there's a dense node field underneath our overlaid pinnedNodes.
  const graphParticipants = 800 as const
  const columnExpanded = participantsListOpen || holdColumnExpanded

  useEffect(() => {
    const id = requestAnimationFrame(() => setMotionReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    return () => {
      if (panelTransitionTimer.current) clearTimeout(panelTransitionTimer.current)
    }
  }, [])

  const clearPanelTransition = () => {
    if (panelTransitionTimer.current) {
      clearTimeout(panelTransitionTimer.current)
      panelTransitionTimer.current = null
    }
  }

  const startPanelTransition = (next: CrowdfundView) => {
    if (view === next || panelPhase !== 'idle') return

    if (next === 'crowdfund') {
      setGraphMode('crowdfund')
      setSelectedAddress(undefined)
    } else if (next === 'myposition') {
      setSelectedAddress(undefined)
    }

    setPanelPhase('exit')
    clearPanelTransition()

    panelTransitionTimer.current = setTimeout(() => {
      setView(next)
      syncUrl(next)
      if (next === 'myposition') setGraphMode('myposition')
      setPanelPhase('enter')
      onViewChange?.(next)

      panelTransitionTimer.current = setTimeout(() => {
        setPanelPhase('idle')
        panelTransitionTimer.current = null
      }, PANEL_ENTER_MS)
    }, PANEL_EXIT_MS + PANEL_GAP_MS)
  }

  // Controlled mode: when the consumer changes `view` from outside, drive the
  // same transition machinery (so the consumer's nav clicks animate identically
  // to internal `goToMyPosition` / `goToCrowdfund` calls). No-op if the prop
  // matches current view, or if a transition is already in flight (the
  // transition completes naturally and lands on the requested target).
  useEffect(() => {
    if (controlledView === undefined) return
    if (controlledView === view) return
    if (panelPhase !== 'idle') return
    startPanelTransition(controlledView)
    // Intentionally exclude `view` and `panelPhase` — re-firing on internal
    // transitions would cause feedback loops. The `controlledView !== view`
    // guard above handles externally-driven changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledView])

  // Sync the MyPosition card's `min-height` to whatever the Crowdfund-view
  // Progress card actually renders to, via the `--hero-progress-card-height`
  // CSS variable. Re-runs when the live data flips out of `loading` (the
  // skeleton's first-child differs from Progress's first-child, so we need
  // to re-measure once the real card mounts). Re-queries `firstElementChild`
  // on each retry so we never measure a detached node from a prior render.
  useLayoutEffect(() => {
    if (isLiveLoading) return
    const stack = leftStackRef.current
    if (!stack) return

    const applyProgressCardHeight = () => {
      const progressCard = stack.firstElementChild as HTMLElement | null
      if (!progressCard) return false
      const h = Math.ceil(progressCard.getBoundingClientRect().height)
      if (h < 1) return false
      stack
        .closest<HTMLElement>('[class*="leftCorner"]')
        ?.style.setProperty('--hero-progress-card-height', `${h}px`)
      return true
    }

    if (applyProgressCardHeight()) return

    const raf = requestAnimationFrame(() => {
      if (!applyProgressCardHeight()) requestAnimationFrame(applyProgressCardHeight)
    })
    return () => cancelAnimationFrame(raf)
  }, [isLiveLoading])

  useLayoutEffect(() => {
    const el = leftStackRef.current
    if (!el || !isCrowdfund) return

    const applyCollapsedHeight = () => {
      el.style.minHeight = '0'
      el.style.maxHeight = 'none'
      const h = Math.ceil(el.getBoundingClientRect().height)
      el.style.minHeight = ''
      el.style.maxHeight = ''
      if (h < 1) return false
      const px = `${h}px`
      el.style.setProperty('--hero-stack-collapsed-height', px)
      el.closest<HTMLElement>('[class*="leftCorner"]')?.style.setProperty('--hero-stack-collapsed-height', px)
      return true
    }

    if (applyCollapsedHeight()) return

    const raf = requestAnimationFrame(() => {
      if (!applyCollapsedHeight()) requestAnimationFrame(applyCollapsedHeight)
    })
    return () => cancelAnimationFrame(raf)
  }, [isCrowdfund])

  useLayoutEffect(() => {
    if (!isCrowdfund) {
      setHoldColumnExpanded(false)
      return
    }
    if (participantsListOpen) {
      setHoldColumnExpanded(true)
      return
    }
    const id = window.setTimeout(() => setHoldColumnExpanded(false), HERO_EXPAND_MS)
    return () => window.clearTimeout(id)
  }, [participantsListOpen, isCrowdfund])

  useEffect(() => {
    if (!isCrowdfund || !selectedAddress) return

    const onPointerDown = (e: PointerEvent) => {
      const el = participantsPanelRef.current
      if (el && el.contains(e.target as Node)) return
      setSelectedAddress(undefined)
    }

    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [selectedAddress, isCrowdfund])

  const syncUrl = (next: CrowdfundView) => {
    const base = import.meta.env.BASE_URL
    const path = next === 'myposition' ? `${base}?view=myposition` : base
    window.history.replaceState(null, '', path)
  }

  const goToMyPosition = () => {
    if (isMyPosition || panelPhase !== 'idle') return
    setParticipantsListOpen(false)
    setSelectedAddress(undefined)
    startPanelTransition('myposition')
  }

  const goToCrowdfund = () => {
    if (isCrowdfund || panelPhase !== 'idle') return
    startPanelTransition('crowdfund')
  }

  const crowdfundPanelVisible = panelVisible(view, 'crowdfund', panelPhase)
  const myPositionPanelVisible = panelVisible(view, 'myposition', panelPhase)
  const crowdfundPanelAnimates = panelAnimates(view, 'crowdfund', panelPhase, motionReady)
  const myPositionPanelAnimates = panelAnimates(view, 'myposition', panelPhase, motionReady)

  const handleGenerateLink = async (slotId: number) => {
    setLoadingId(slotId)
    await new Promise((r) => setTimeout(r, 800))
    setLoadingId(null)
  }

  const handleCopy = (slotId: number, link: string) => {
    navigator.clipboard.writeText(link)
    setCopiedId(slotId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleRevoke = async () => {}
  const handleInviteOnchain = async (slotId: number) => {
    setLoadingId(slotId)
    await new Promise((r) => setTimeout(r, 800))
    setLoadingId(null)
  }

  // Build PinnedNode[] from the dashboard rows (one per unique wallet). Each
  // row carries inviter + multiHop, which the upgraded NodeSphere uses to
  // render the real invite tree edges and the multi-hop halo rings.
  const crowdfundPinnedNodes = useMemo(
    () =>
      dashRows.map((p) => ({
        kind:
          p.hop === 'Hop 0'
            ? ('Hop 0' as const)
            : p.hop === 'Hop 1'
              ? ('Hop 1' as const)
              : ('Hop 2' as const),
        address: p.address,
        committed: `$${p.amountUsd.toLocaleString()} committed`,
        inviters: p.inviters,
        multiHop: p.multiHop,
      })),
    [dashRows],
  )

  return (
    <div className={[mpStyles.page, shellStyles.page].join(' ')}>
      <NodeSphere
        highlightAddress={
          isGraphMyPosition ? selectedAddress ?? myPositionWalletAddress : selectedAddress
        }
        onSelectAddress={setSelectedAddress}
        filterKind={
          isGraphCrowdfund
            ? filter === 'seed'
              ? 'Hop 0'
              : filter === 'hop1'
                ? 'Hop 1'
                : filter === 'hop2'
                  ? 'Hop 2'
                  : filter === 'multi'
                    ? 'Multi-hop'
                    : undefined
            : undefined
        }
        interactionDisabled={isGraphCrowdfund && participantsListOpen}
        scenarioParticipants={graphParticipants}
        scenarioSeed={seedRef.current!}
        pinnedNodes={crowdfundPinnedNodes}
        walletAddress={myPositionWalletAddress}
        lockOnWallet={isGraphMyPosition}
        inviteGraph={isGraphMyPosition}
        etherscanBaseUrl={etherscanBaseUrl}
      />

      {header === undefined ? (
        // Default header — used by the showcase / standalone mockup preview.
        // Consuming apps pass their own `header` slot (or `null`) to avoid
        // rendering two chrome bars.
        <Header
          activeNav={isMyPosition ? 'myposition' : 'crowdfund'}
          walletAddress={myPositionWalletDisplay}
          autoHideOnScroll={false}
          className={[heroStyles.headerOverride, heroStyles.enter, heroStyles.enterHeader].join(' ')}
          onMyPosition={goToMyPosition}
          onCrowdfund={goToCrowdfund}
        />
      ) : (
        header
      )}

      <div
        className={[
          heroStyles.leftCorner,
          shellStyles.leftCorner,
          isCrowdfund && participantsListOpen && heroStyles.leftCornerExpanded,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div
          className={layerClass(crowdfundPanelVisible, motionReady, crowdfundPanelAnimates)}
          aria-hidden={!crowdfundPanelVisible}
        >
          <div
            ref={leftStackRef}
            className={[heroStyles.leftStack, heroStyles.enter, heroStyles.enterProgress].join(' ')}
          >
            {isLiveLoading ? (
              <HeroLoadingSkeleton />
            ) : (
              <>
                <Progress
                  participants={`${dashRows.length} PARTICIPANTS`}
                  committedAmount={committedAmount}
                  minRaiseAmount={Number(CROWDFUND_CONSTANTS.MIN_SALE / 1_000_000n)}
                  maxAmount={Number(CROWDFUND_CONSTANTS.MAX_SALE / 1_000_000n)}
                  {...(liveReady?.daysLeftLabel !== undefined
                    ? { daysLeft: liveReady.daysLeftLabel }
                    : {})}
                  {...(liveReady?.saleStatusLabel
                    ? { status: liveReady.saleStatusLabel }
                    : {})}
                  {...(liveReady?.saleStatusDot
                    ? { statusDot: liveReady.saleStatusDot }
                    : {})}
                />
                <div ref={participantsPanelRef} className={heroStyles.participantsWrap}>
                  <HeroParticipantsPanel
                    participants={participants}
                    selectedAddress={selectedAddress}
                    onSelectAddress={setSelectedAddress}
                    collapsedMaxRows={3}
                    filter={filter}
                    onFilterChange={setFilter}
                    layoutExpanded={columnExpanded}
                    showList={participantsListOpen}
                    onShowListChange={(open) => {
                      setParticipantsListOpen(open)
                      if (!open) setSelectedAddress(undefined)
                    }}
                    onParticipate={onParticipate}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <div
          className={layerClass(myPositionPanelVisible, motionReady, myPositionPanelAnimates)}
          aria-hidden={!myPositionPanelVisible}
        >
          <section className={mpStyles.positionCard} aria-label="Your position">
            <div className={mpStyles.cardHeader}>
              <h1 className={mpStyles.pageTitle}>My Position</h1>
              <div className={mpStyles.metaTags}>
                {myPositionWalletDisplay && (
                  <Tag label={myPositionWalletDisplay} dot="lavender" />
                )}
                {myPositionEmptyKind === null &&
                  myPositionHopChips.map((chip) => (
                    <Tag key={chip.key} label={chip.label} dotColor={chip.dotColor} />
                  ))}
                {myPositionEmptyKind === null && myPositionTerminalClaimed && (
                  <Tag label="CLAIMED" dot="active" />
                )}
              </div>
            </div>

            {myPositionEmptyKind !== null ? (
              <MyPositionEmptyState
                kind={myPositionEmptyKind}
                onConnectWallet={onConnectWallet}
                onParticipate={onParticipate}
              />
            ) : (
            <div className={mpStyles.positionFooter}>
              <div className={mpStyles.statsRow}>
                <div className={mpStyles.statBlock}>
                  <p className={mpStyles.statLabel}>USDC committed</p>
                  <p className={mpStyles.statAmount}>
                    {formatUsdcCommitted(myPositionCommittedUsd)}
                  </p>
                </div>

                {myPositionRefundMode ? (
                  // Sale didn't meet the minimum raise (or was cancelled) —
                  // the user's outcome is a USDC refund, not an ARM
                  // allocation. Swap the stat block accordingly.
                  <div className={mpStyles.statBlock}>
                    <div className={mpStyles.statLabelRow}>
                      <p className={mpStyles.statLabel}>USDC refund</p>
                      <Tooltip
                        variant="centered"
                        content={
                          myPositionRefundClaimed
                            ? 'Claimed · returned to your wallet'
                            : myPositionCancelled
                              ? 'Available for claim. The sale was cancelled by the security council — your committed USDC will be returned to your wallet.'
                              : myPositionFinalized
                                ? 'Available for claim. Your committed USDC will be returned to your wallet.'
                                : 'Pending finalization. The sale fell below the minimum raise — your committed USDC will be returned to your wallet.'
                        }
                      >
                        <button
                          type="button"
                          className={mpStyles.infoTrigger}
                          aria-label="USDC refund info"
                        >
                          <InformationCircleIcon className={mpStyles.infoIcon} aria-hidden />
                        </button>
                      </Tooltip>
                    </div>
                    <p className={mpStyles.statAmountAccent}>
                      {formatUsdcCommitted(myPositionRefundUsd)}
                    </p>
                  </div>
                ) : (
                  <div className={mpStyles.statBlock}>
                    <div className={mpStyles.statLabelRow}>
                      <p className={mpStyles.statLabel}>ARM allocation</p>
                      <Tooltip
                        variant="centered"
                        content={
                          myPositionArmClaimed
                            ? 'Claimed · in your wallet'
                            : myPositionFinalized
                              ? 'Available for claim. Any committed USDC not used to buy ARM is included as a refund in the same transaction.'
                              : 'Estimated · pending finalization. Any committed USDC not used to buy ARM will be refunded at finalization.'
                        }
                      >
                        <button
                          type="button"
                          className={mpStyles.infoTrigger}
                          aria-label="ARM allocation info"
                        >
                          <InformationCircleIcon className={mpStyles.infoIcon} aria-hidden />
                        </button>
                      </Tooltip>
                    </div>
                    <p className={mpStyles.statAmountAccent}>
                      {formatArmAllocation(myPositionArmNumber)}
                    </p>
                  </div>
                )}
              </div>

              <div className={mpStyles.barSection}>
                <div className={mpStyles.barTrack}>
                  <div
                    className={mpStyles.barFill}
                    style={{ width: `${myPositionFillPct}%` }}
                  />
                </div>
                <div className={mpStyles.barLabels}>
                  <span className={mpStyles.barCaption}>
                    {Math.round(myPositionFillPct)}% of cap
                  </span>
                  <span className={mpStyles.barCaption}>
                    Cap {formatUsdcCommitted(myPositionCapUsd)}
                  </span>
                </div>
              </div>
            </div>
            )}
          </section>
        </div>
      </div>

      <div className={[heroStyles.rightCorner, shellStyles.rightCorner].join(' ')}>
        {participationEnabled && (
          <div
            className={[
              layerClass(crowdfundPanelVisible, motionReady, crowdfundPanelAnimates),
              shellStyles.rightParticipateLayer,
            ]
              .filter(Boolean)
              .join(' ')}
            aria-hidden={!crowdfundPanelVisible}
          >
            <Participate
              className={[heroStyles.enter, heroStyles.enterParticipate].join(' ')}
              imageSrc={fleetPng}
              videoSrc={fleetMp4}
              onCtaClick={onParticipate}
            />
          </div>
        )}

        {participationEnabled && !myPositionCancelled && myPositionEmptyKind === null && (
        <div
          className={layerClass(myPositionPanelVisible, motionReady, myPositionPanelAnimates)}
          aria-hidden={!myPositionPanelVisible}
        >
          {(() => {
            // Available / total counts shown in the collapsible header. Counts the
            // raw SlotData arrays across all live sections (or DEMO_SLOTS in the
            // showcase path) — "available" === `status === 'empty'`.
            const allSlots = inviteSlotSections
              ? inviteSlotSections.flatMap((s) => s.config.slots)
              : DEMO_SLOTS
            const inviteAvailableCount = allSlots.filter((s) => s.status === 'empty').length
            const inviteTotalCount = allSlots.length
            return (
          <section className={mpStyles.inviteCard} aria-label="Your invites">
            <button
              type="button"
              className={mpStyles.inviteHeader}
              onClick={() => setInvitesExpanded((open) => !open)}
              aria-expanded={invitesExpanded}
              aria-controls={invitesListId}
              aria-label={`${invitesExpanded ? 'Collapse' : 'Expand'} invites, ${inviteAvailableCount} of ${inviteTotalCount} available`}
            >
              <span className={mpStyles.inviteTitle} role="heading" aria-level={2}>
                Your Invites
              </span>
              <span className={mpStyles.inviteHeaderActions}>
                <span className={mpStyles.inviteHeaderCount} aria-hidden>
                  {inviteAvailableCount} of {inviteTotalCount}
                </span>
                <ChevronDownIcon
                  className={[
                    mpStyles.inviteHeaderChevron,
                    !invitesExpanded && mpStyles.inviteHeaderChevronCollapsed,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden
                />
              </span>
            </button>
            <div
              id={invitesListId}
              className={[!invitesExpanded && mpStyles.inviteBodyCollapsed]
                .filter(Boolean)
                .join(' ')}
            >
            {(() => {
              // Three render modes:
              //   1. live sections supplied AND non-empty → render per-hop sections (hop header
              //      hidden when there's only one section so single-hop UX is unchanged)
              //   2. live sections supplied but all empty → "no invite slots" message
              //   3. no live sections (showcase / mock preview) → DEMO_SLOTS with mock handlers
              if (inviteSlotSections) {
                const isEmpty =
                  inviteSlotSections.length === 0 ||
                  inviteSlotSections.every((s) => s.config.slots.length === 0)
                if (isEmpty) {
                  return (
                    <div className={mpStyles.inviteEmpty} role="status">
                      <p className={mpStyles.inviteEmptyText}>
                        You have no invite slots available at this hop.
                      </p>
                    </div>
                  )
                }
                const showHeaders = inviteSlotSections.length > 1
                return (
                  <div className={mpStyles.slotList}>
                    {inviteSlotSections.map((section) => (
                      <div key={section.hop} className={mpStyles.inviteSection}>
                        {showHeaders && (
                          <div className={mpStyles.inviteSectionHeader}>
                            <span
                              className={mpStyles.inviteSectionDot}
                              style={{ background: section.hopColor }}
                              aria-hidden
                            />
                            <span className={mpStyles.inviteSectionLabel}>
                              {section.hopLabel}
                            </span>
                            <span className={mpStyles.inviteSectionCount}>
                              ({section.totalSlots}{' '}
                              {section.totalSlots === 1 ? 'slot' : 'slots'})
                            </span>
                          </div>
                        )}
                        {section.config.slots.map((slot) => (
                          <SlotCard
                            key={slot.id}
                            slot={slot}
                            onGenerateLink={section.config.onGenerateLink}
                            onCopy={section.config.onCopy}
                            onRevoke={section.config.onRevoke}
                            onInviteOnchain={section.config.onInviteOnchain}
                            copied={section.config.copiedId === slot.id}
                            loading={section.config.loadingId === slot.id}
                            resolveEns={section.config.resolveEns}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )
              }
              // Showcase / mock path (no live sections).
              return (
                <div className={mpStyles.slotList}>
                  {DEMO_SLOTS.map((slot) => (
                    <SlotCard
                      key={slot.id}
                      slot={slot}
                      onGenerateLink={handleGenerateLink}
                      onCopy={handleCopy}
                      onRevoke={handleRevoke}
                      onInviteOnchain={handleInviteOnchain}
                      copied={copiedId === slot.id}
                      loading={loadingId === slot.id}
                    />
                  ))}
                </div>
              )
            })()}
            </div>
          </section>
            )
          })()}
        </div>
        )}
      </div>
    </div>
  )
}

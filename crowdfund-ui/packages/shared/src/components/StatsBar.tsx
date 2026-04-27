// ABOUTME: 4-card stats banner — Total Committed, Your Allocation, Participants, Time Remaining.
// ABOUTME: Plus per-hop oversubscription strip below. All data comes in via props.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Clock, DollarSign, UserCheck, Users } from 'lucide-react'
import { formatArm, formatCountdown, formatUsdc } from '../lib/format.js'
import { CROWDFUND_CONSTANTS, HOP_CONFIGS } from '../lib/constants.js'
import { estimateAllocation } from '../lib/allocation.js'
import { Skeleton } from './ui/skeleton.js'
import { InfoTooltip } from './InfoTooltip.js'

const numberFade = {
  initial: { opacity: 0, y: -2 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.15 },
}

export interface HopStatsData {
  totalCommitted: bigint
  cappedCommitted: bigint
  whitelistCount: number
  uniqueCommitters: number
}

export interface UserAllocation {
  /** Connected user's est. ARM allocation if finalized now (18 dec). */
  estArmAllocation: bigint
  /** Number of distinct hops the user has positions in. */
  hopCount: number
}

export interface StatsBarProps {
  hopStats: HopStatsData[]
  totalCommitted: bigint
  cappedDemand: bigint
  saleSize: bigint
  participantCount: number
  phase: number
  armLoaded: boolean
  windowEnd: number
  blockTimestamp: number
  /** Connected user's projected allocation. Undefined when no wallet is
   *  connected — the card falls back to a "Connect wallet" placeholder. */
  userAllocation?: UserAllocation
  /** When true with no hop data yet, renders skeleton chrome. */
  isLoading?: boolean
}

/** Card icon recipe — mirrors TableView's hop avatar so card icons and
 *  table avatars share the same surface (15% tint over card, 2px solid
 *  hue ring, soft 4px outer glow). Pass the brighter `-icon` variant
 *  where the theme defines one for tighter glyph contrast. */
function cardIconStyle(token: string, iconToken?: string): CSSProperties {
  return {
    background: `color-mix(in oklch, var(${token}) 15%, var(--card) 85%)`,
    border: `2px solid var(${token})`,
    boxShadow: `0 0 4px color-mix(in oklch, var(${token}) 22%, transparent)`,
    color: `var(${iconToken ?? token})`,
  }
}

/** "May 28, 2025" from a unix timestamp (seconds). Returns null at 0. */
function formatEndDate(unixSeconds: number): string | null {
  if (unixSeconds <= 0) return null
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Phase-aware time card content. Shows live countdown in commit window;
 *  switches to terminal labels in finalized / cancelled states. */
function timeRemainingDisplay(
  phase: number,
  armLoaded: boolean,
  windowEnd: number,
  localTime: number,
): { primary: string; sub: string | null } {
  if (phase === 2) return { primary: 'Cancelled', sub: 'Refunds available' }
  if (phase === 1) return { primary: 'Sale closed', sub: 'Claim window open' }
  if (!armLoaded) return { primary: 'Not yet open', sub: null }
  if (windowEnd === 0) return { primary: '—', sub: null }
  const remaining = Math.max(0, windowEnd - localTime)
  const endLabel = formatEndDate(windowEnd)
  if (remaining === 0) {
    return { primary: 'Closed', sub: endLabel ? `ended ${endLabel}` : null }
  }
  return {
    primary: formatCountdown(remaining),
    sub: endLabel ? `ends ${endLabel}` : null,
  }
}

/** One stat card (icon + label + primary value + subline). */
function StatCard({
  icon,
  iconStyle,
  label,
  primary,
  primaryClassName,
  sub,
  primaryAnimateKey,
}: {
  icon: ReactNode
  iconStyle: CSSProperties
  label: ReactNode
  primary: ReactNode
  primaryClassName?: string
  sub?: ReactNode
  primaryAnimateKey?: string | number
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/80 p-4 shadow-elevated backdrop-blur-sm">
      {/* Icon row sits at the top of the card (not vertically centered) so
       *  it lines up with Card 1's icon, which is forced to the top by the
       *  progress bar that hangs below it. */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-full"
          style={iconStyle}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <motion.div
            key={primaryAnimateKey ?? String(primary)}
            {...numberFade}
            className={`mt-0.5 truncate text-xl font-semibold leading-tight ${primaryClassName ?? 'text-foreground'}`}
          >
            {primary}
          </motion.div>
          {sub && (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {sub}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Per-hop oversubscription strip below the cards.
 *  Each hop shows its label, fill %, and a tiny progress bar. */
function PerHopStrip({
  hopStats,
  saleSize,
}: {
  hopStats: HopStatsData[]
  saleSize: bigint
}) {
  const effectiveSaleSize =
    saleSize > 0n ? saleSize : CROWDFUND_CONSTANTS.BASE_SALE
  // Hop color tokens defined in theme.css. Bar fills use the same
  // primary→primary/65 gradient recipe as TableView's invites bar, swapping
  // the hop hue in for visual consistency across the surface.
  const palette: Array<{ text: string; bar: string; track: string }> = [
    {
      text: 'text-hop-0',
      bar: 'bg-gradient-to-r from-hop-0 via-hop-0/90 to-hop-0/65',
      track: 'bg-hop-0/15',
    },
    {
      text: 'text-hop-1',
      bar: 'bg-gradient-to-r from-hop-1 via-hop-1/90 to-hop-1/65',
      track: 'bg-hop-1/15',
    },
    {
      text: 'text-hop-2',
      bar: 'bg-gradient-to-r from-hop-2 via-hop-2/90 to-hop-2/65',
      track: 'bg-hop-2/15',
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 px-1 sm:grid-cols-3">
      {hopStats.map((stat, hop) => {
        const cfg = HOP_CONFIGS[hop]
        const ceilingBps = cfg?.ceilingBps ?? 0
        const ceiling =
          ceilingBps > 0
            ? (effectiveSaleSize * BigInt(ceilingBps)) / 10_000n
            : 0n
        const pct =
          ceiling > 0n
            ? Math.min(999, Number((stat.cappedCommitted * 100n) / ceiling))
            : 0
        const visualWidth = Math.min(100, pct)
        const colors = palette[hop] ?? palette[0]
        return (
          <div key={hop} className="flex items-center gap-2 tabular-nums">
            <div className="w-10 text-[10px] uppercase tracking-wide text-muted-foreground">
              Hop {hop}
            </div>
            <div className={`h-1 flex-1 overflow-hidden rounded-full ${colors.track}`}>
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${colors.bar}`}
                style={{ width: `${visualWidth}%` }}
              />
            </div>
            <div className="w-8 text-right text-[10px] text-muted-foreground">
              {ceilingBps > 0 ? `${pct}%` : '—'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatsBarSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/80 p-4 backdrop-blur-sm"
          >
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 px-1 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-2.5 w-10" />
            <Skeleton className="h-1 flex-1 rounded-full" />
            <Skeleton className="h-2.5 w-8" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function StatsBar(props: StatsBarProps) {
  const {
    hopStats,
    totalCommitted,
    cappedDemand,
    saleSize,
    participantCount,
    phase,
    armLoaded,
    windowEnd,
    blockTimestamp,
    userAllocation,
    isLoading,
  } = props

  if (isLoading && hopStats.length === 0) {
    return <StatsBarSkeleton />
  }

  // Smooth countdown — increment locally between block-timestamp polls so
  // the time card ticks every second without thrashing the contract.
  const [localTime, setLocalTime] = useState(blockTimestamp)
  const baseTimeRef = useRef(blockTimestamp)
  const wallStartRef = useRef(Date.now())

  useEffect(() => {
    baseTimeRef.current = blockTimestamp
    wallStartRef.current = Date.now()
    setLocalTime(blockTimestamp)
  }, [blockTimestamp])

  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - wallStartRef.current) / 1000)
      setLocalTime(baseTimeRef.current + elapsed)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const estimate = estimateAllocation(hopStats, cappedDemand, saleSize)
  const committedDiffers = totalCommitted !== cappedDemand
  const belowMin =
    estimate.totalAllocUsdc < CROWDFUND_CONSTANTS.MIN_SALE && cappedDemand > 0n

  // Total Committed card — progress bar is "capped demand vs sale size".
  // Pre-finalize, sale size is 0; estimate.effectiveSaleSize gives the
  // BASE/MAX projection used elsewhere in the UI.
  const denomForBar = estimate.effectiveSaleSize
  const fillPct =
    denomForBar > 0n
      ? Math.min(999, Number((cappedDemand * 100n) / denomForBar))
      : 0
  const visualFill = Math.min(100, fillPct)

  // Total whitelisted addresses — sum of whitelist slots across hops.
  // Note: this counts hop-positions, not unique addresses (an address on
  // multiple hops contributes once per hop). For the POC's invite topology
  // this is close to "addresses invited to participate".
  const totalWhitelisted = hopStats.reduce(
    (sum, s) => sum + s.whitelistCount,
    0,
  )

  const time = timeRemainingDisplay(phase, armLoaded, windowEnd, localTime)

  // Card 2 — connected: est. ARM + hop count; disconnected: muted prompt.
  const yourAllocPrimary = userAllocation
    ? formatArm(userAllocation.estArmAllocation)
    : 'Connect wallet'
  const yourAllocSub = userAllocation
    ? `across ${userAllocation.hopCount} hop${userAllocation.hopCount === 1 ? '' : 's'}`
    : 'to estimate your allocation'
  const yourAllocClass = userAllocation ? 'text-foreground' : 'text-muted-foreground'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Card 1 — Total Committed (with sale-size progress bar) */}
        <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/80 p-4 shadow-elevated backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-full"
              style={cardIconStyle('--hop-root', '--hop-root-icon')}
            >
              <DollarSign className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Total Committed
                {committedDiffers && (
                  <InfoTooltip
                    iconSize={11}
                    text="Effective demand differs from total committed because some participants committed above their per-slot cap."
                  />
                )}
              </div>
              <motion.div
                key={formatUsdc(totalCommitted)}
                {...numberFade}
                className="mt-0.5 truncate text-xl font-semibold leading-tight text-foreground tabular-nums"
              >
                {formatUsdc(totalCommitted)}
              </motion.div>
              {/* Sub-line — mirrors the "across 1 hop", "of 294 addresses",
               *  "ends May 28, 2025" sub-lines on the other cards. */}
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">
                of {formatUsdc(denomForBar)}
              </div>
            </div>
          </div>
          {/* Progress bar with % on the right */}
          <div className="flex items-center gap-1.5 tabular-nums">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hop-root/15">
              <div
                className="h-full rounded-full bg-gradient-to-r from-hop-root via-hop-root/90 to-hop-root/65 transition-[width] duration-300"
                style={{ width: `${visualFill}%` }}
              />
            </div>
            <div className="text-[11px] leading-none text-muted-foreground">
              {fillPct}%
            </div>
          </div>
        </div>

        {/* Card 2 — Your Allocation */}
        <StatCard
          icon={<UserCheck className="size-5" />}
          iconStyle={cardIconStyle('--hop-0', '--hop-0-icon')}
          label="Your Allocation"
          primary={yourAllocPrimary}
          primaryClassName={`tabular-nums ${yourAllocClass}`}
          sub={yourAllocSub}
          primaryAnimateKey={yourAllocPrimary}
        />

        {/* Card 3 — Participants */}
        <StatCard
          icon={<Users className="size-5" />}
          iconStyle={cardIconStyle('--primary')}
          label="Participants"
          primary={
            <span className="tabular-nums">
              {participantCount}
            </span>
          }
          sub={`of ${totalWhitelisted} addresses`}
          primaryAnimateKey={participantCount}
        />

        {/* Card 4 — Time Remaining */}
        <StatCard
          icon={<Clock className="size-5" />}
          iconStyle={cardIconStyle('--hop-2')}
          label="Time Remaining"
          primary={
            <span className="tabular-nums">{time.primary}</span>
          }
          sub={time.sub}
          primaryAnimateKey={time.primary}
        />
      </div>

      {/* Per-hop oversubscription strip */}
      <PerHopStrip hopStats={hopStats} saleSize={saleSize} />

      {/* Below-min refund warning — only inline footnote we keep visible.
       *  Other divergence explanations live in InfoTooltips on the relevant
       *  numbers above. */}
      {belowMin && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          Estimated allocation is below the minimum raise (
          {formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)}). The sale would enter
          refund mode if finalized now.
        </div>
      )}
    </div>
  )
}

// ABOUTME: Live stats banner showing per-hop demand, sale size, phase, and countdown.
// ABOUTME: Accepts all data via props — no internal data fetching.

import { useState, useEffect, useRef } from 'react'
import {
  formatUsdc,
  hopLabel,
  phaseName,
  phaseColor,
  formatCountdown,
} from '../lib/format.js'
import { CROWDFUND_CONSTANTS, HOP_CONFIGS } from '../lib/constants.js'
import { estimateAllocation } from '../lib/allocation.js'
import { Skeleton } from './ui/skeleton.js'

export interface HopStatsData {
  totalCommitted: bigint
  cappedCommitted: bigint
  whitelistCount: number
  uniqueCommitters: number
}

export interface ConnectedSummary {
  totalCommitted: bigint
  hopCount: number
}

export interface StatsBarProps {
  hopStats: HopStatsData[]
  totalCommitted: bigint
  cappedDemand: bigint
  saleSize: bigint
  phase: number
  armLoaded: boolean
  seedCount: number
  participantCount: number
  windowEnd: number
  blockTimestamp: number
  connectedSummary?: ConnectedSummary
  /** When true with no hop data yet, renders skeleton chrome instead of the live bar. */
  isLoading?: boolean
}

function StatsBarSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-20 rounded" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded border border-border p-3 space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  )
}

/** Compute oversubscription percentage for a hop.
 *  Pre-finalization saleSize is 0; fall back to BASE_SALE for ceiling estimates. */
function oversubPct(cappedCommitted: bigint, hop: number, saleSize: bigint): string {
  const ceilingBps = HOP_CONFIGS[hop]?.ceilingBps ?? 0
  if (ceilingBps === 0) return '—'
  const effectiveSaleSize = saleSize > 0n ? saleSize : CROWDFUND_CONSTANTS.BASE_SALE
  const ceiling = (effectiveSaleSize * BigInt(ceilingBps)) / 10_000n
  if (ceiling === 0n) return '—'
  const pct = Number((cappedCommitted * 100n) / ceiling)
  return `${pct}%`
}

/** Determine sale size label (BASE or EXPANDED) */
function saleSizeLabel(saleSize: bigint): string {
  if (saleSize <= CROWDFUND_CONSTANTS.BASE_SALE) return 'BASE'
  return 'EXPANDED'
}

export function StatsBar(props: StatsBarProps) {
  const {
    hopStats,
    totalCommitted,
    cappedDemand,
    saleSize,
    phase,
    armLoaded,
    seedCount,
    participantCount,
    windowEnd,
    blockTimestamp,
    isLoading,
  } = props

  if (isLoading && hopStats.length === 0) {
    return <StatsBarSkeleton />
  }

  // Smooth countdown: increment locally from blockTimestamp
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

  const remaining = windowEnd - localTime

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {/* Top row: phase badge + sale size + countdown */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className={`px-2 py-1 rounded text-xs font-medium ${phaseColor(phase)}`}>
            {phaseName(phase)}
          </span>
          {armLoaded && (
            <span className="text-xs text-muted-foreground">
              Sale: {formatUsdc(saleSize)} ({saleSizeLabel(saleSize)})
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            Seeds: <span className="text-foreground font-medium">{seedCount}</span>
          </span>
          <span className="text-muted-foreground">
            Participants: <span className="text-foreground font-medium">{participantCount}</span>
          </span>
          {phase === 0 && windowEnd > 0 && (
            <span className="text-muted-foreground">
              Ends: <span className="text-foreground font-medium">{formatCountdown(remaining)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Bottom row: per-hop stats */}
      <div className="grid grid-cols-3 gap-4">
        {hopStats.map((stat, hop) => (
          <div key={hop} className="rounded border border-border p-3">
            <div className="text-xs text-muted-foreground mb-1">{hopLabel(hop)}</div>
            <div className="text-lg font-semibold">{formatUsdc(stat.cappedCommitted)}</div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
              <span>
                {stat.uniqueCommitters}/{stat.whitelistCount} committed
              </span>
              {HOP_CONFIGS[hop]?.ceilingBps > 0 && (
                <span>
                  {oversubPct(stat.cappedCommitted, hop, saleSize)} of ceiling
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Aggregate totals */}
      {(() => {
        const estimate = estimateAllocation(hopStats, cappedDemand, saleSize)
        const committedDiffers = totalCommitted !== cappedDemand
        const allocationDiffers = estimate.totalAllocUsdc < cappedDemand
        const belowMin = estimate.totalAllocUsdc < CROWDFUND_CONSTANTS.MIN_SALE && cappedDemand > 0n

        return (
          <div className="mt-3 space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Total committed: <span className="text-foreground font-medium">{formatUsdc(totalCommitted)}</span>
              </span>
              {props.connectedSummary && props.connectedSummary.totalCommitted > 0n && (
                <span className="text-muted-foreground">
                  You: <span className="text-foreground font-medium">{formatUsdc(props.connectedSummary.totalCommitted)}</span>
                  {props.connectedSummary.hopCount > 0 && (
                    <span> across {props.connectedSummary.hopCount} hop{props.connectedSummary.hopCount !== 1 ? 's' : ''}</span>
                  )}
                </span>
              )}
              <span className="text-muted-foreground">
                Effective demand: <span className="text-foreground font-medium">{formatUsdc(cappedDemand)}</span>
              </span>
              <span className="text-muted-foreground">
                Est. allocation: <span className={`font-medium ${belowMin ? 'text-destructive' : 'text-foreground'}`}>{formatUsdc(estimate.totalAllocUsdc)}</span>
              </span>
            </div>
            {/* Explanatory notes when values diverge */}
            {(committedDiffers || allocationDiffers) && (
              <div className="text-[10px] text-muted-foreground space-y-0.5">
                {committedDiffers && (
                  <div>Effective demand differs from total committed because some participants committed above their per-slot cap.</div>
                )}
                {allocationDiffers && (
                  <div>Est. allocation is lower than effective demand because hop ceilings limit how much each hop can absorb.</div>
                )}
                {belowMin && (
                  <div className="text-destructive">Estimated allocation is below the minimum raise ({formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)}). The sale would enter refund mode if finalized now.</div>
                )}
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

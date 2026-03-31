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
}

/** Compute oversubscription percentage for a hop */
function oversubPct(cappedCommitted: bigint, hop: number, saleSize: bigint): string {
  const ceilingBps = HOP_CONFIGS[hop]?.ceilingBps ?? 0
  if (ceilingBps === 0) return '—'
  const ceiling = (saleSize * BigInt(ceilingBps)) / 10_000n
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
  } = props

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
      <div className="mt-3 flex items-center justify-between text-sm">
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
          Capped demand: <span className="text-foreground font-medium">{formatUsdc(cappedDemand)}</span>
        </span>
      </div>
    </div>
  )
}

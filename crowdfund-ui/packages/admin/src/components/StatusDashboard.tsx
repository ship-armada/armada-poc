// ABOUTME: Full-width status dashboard showing phase, timeline, progress, and hop stats.
// ABOUTME: Includes smooth countdown timer and LT budget tracker (launch team only).

import { useState, useEffect } from 'react'
import {
  formatUsdc,
  formatCountdown,
  phaseName,
  phaseColor,
  hopLabel,
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'
import type { AdminState } from '@/hooks/useAdminState'
import type { AdminRole } from '@/hooks/useRole'

export interface StatusDashboardProps {
  state: AdminState
  role: AdminRole
}

function TimelineRow(props: { label: string; isOpen: boolean; endTimestamp: number; now: number }) {
  const { label, isOpen, endTimestamp, now } = props
  const remaining = endTimestamp - now

  return (
    <div className="rounded border border-border p-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{label}</span>
        {endTimestamp > 0 && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
            isOpen ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
          }`}>
            {isOpen ? 'OPEN' : 'CLOSED'}
          </span>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {endTimestamp === 0
          ? 'Not yet set'
          : <>
              {remaining > 0 ? formatCountdown(remaining) : 'ended'}
              {' — '}
              {new Date(endTimestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </>
        }
      </div>
    </div>
  )
}

export function StatusDashboard({ state, role }: StatusDashboardProps) {
  // Smooth countdown: increment block timestamp locally every second
  const [localTimestamp, setLocalTimestamp] = useState(state.blockTimestamp)

  useEffect(() => {
    setLocalTimestamp(state.blockTimestamp)
  }, [state.blockTimestamp])

  useEffect(() => {
    const id = setInterval(() => {
      setLocalTimestamp((prev) => prev + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const { MAX_SALE, MIN_SALE, ELASTIC_TRIGGER } = CROWDFUND_CONSTANTS
  const progressPct = MAX_SALE > 0n ? Number((state.totalCommitted * 100n) / MAX_SALE) : 0
  const minPct = MAX_SALE > 0n ? Number((MIN_SALE * 100n) / MAX_SALE) : 0
  const elasticPct = MAX_SALE > 0n ? Number((ELASTIC_TRIGGER * 100n) / MAX_SALE) : 0

  const saleLabel = state.saleSize > CROWDFUND_CONSTANTS.BASE_SALE ? 'EXPANDED' : 'BASE'

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      {/* Phase + sale size */}
      <div className="flex items-center gap-3">
        <span className={`text-xs px-2 py-1 rounded font-medium ${phaseColor(state.phase)}`}>
          {phaseName(state.phase)}
        </span>
        <span className="text-sm text-muted-foreground">
          Sale: {formatUsdc(state.saleSize)} ({saleLabel})
        </span>
        {state.armLoaded ? (
          <span className="text-xs text-success">ARM Loaded</span>
        ) : (
          <span className="text-xs text-amber-500">ARM Not Loaded</span>
        )}
      </div>

      {/* Timeline */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
        <TimelineRow
          label="Week 1 (Seeds + LT Invites)"
          isOpen={state.phase === 0 && localTimestamp >= state.windowStart && localTimestamp < state.launchTeamInviteEnd}
          endTimestamp={state.launchTeamInviteEnd}
          now={localTimestamp}
        />
        <TimelineRow
          label="Commitment Window"
          isOpen={state.phase === 0 && state.armLoaded && localTimestamp >= state.windowStart && localTimestamp <= state.windowEnd}
          endTimestamp={state.windowEnd}
          now={localTimestamp}
        />
        <TimelineRow
          label="Claim Period"
          isOpen={state.phase === 1 && localTimestamp <= state.claimDeadline}
          endTimestamp={state.claimDeadline}
          now={localTimestamp}
        />
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Total Committed: {formatUsdc(state.totalCommitted)}</span>
          <span>Max: {formatUsdc(MAX_SALE)}</span>
        </div>
        <div className="relative h-4 rounded-full bg-muted overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-500"
            style={{ width: `${Math.min(progressPct, 100)}%` }}
          />
          {/* MIN_SALE marker */}
          <div
            className="absolute inset-y-0 w-px bg-amber-500"
            style={{ left: `${minPct}%` }}
            title={`Min: ${formatUsdc(MIN_SALE)}`}
          />
          {/* ELASTIC_TRIGGER marker */}
          <div
            className="absolute inset-y-0 w-px bg-info"
            style={{ left: `${elasticPct}%` }}
            title={`Elastic: ${formatUsdc(ELASTIC_TRIGGER)}`}
          />
        </div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> Min ({formatUsdc(MIN_SALE)})
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-info" /> Elastic ({formatUsdc(ELASTIC_TRIGGER)})
          </span>
        </div>
      </div>

      {/* Per-hop stats table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 pr-4">Hop</th>
              <th className="py-1 pr-4">Ceiling</th>
              <th className="py-1 pr-4">Cap/Slot</th>
              <th className="py-1 pr-4">Whitelist</th>
              <th className="py-1 pr-4">Committers</th>
              <th className="py-1 pr-4">Committed</th>
              <th className="py-1 pr-4">Capped</th>
              <th className="py-1 pr-4">Over/Under</th>
            </tr>
          </thead>
          <tbody>
            {state.hopStats.map((stats, hop) => {
              const hopConfig = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop] : null
              const isFloorHop = hop === 2
              const ceilingBps = isFloorHop ? CROWDFUND_CONSTANTS.HOP2_FLOOR_BPS : (hopConfig?.ceilingBps ?? 0)
              const effectiveCeiling = state.saleSize * BigInt(ceilingBps) / 10000n
              const overUnderPct = effectiveCeiling > 0n
                ? Number(stats.cappedCommitted * 10000n / effectiveCeiling) / 100
                : 0
              const overUnderColor = overUnderPct <= 100
                ? 'text-success'
                : overUnderPct <= 120 ? 'text-amber-500' : 'text-destructive'

              return (
                <tr key={hop} className="border-b border-border/50">
                  <td className="py-1 pr-4 font-medium">{hopLabel(hop)}</td>
                  <td className="py-1 pr-4">
                    {isFloorHop ? 'Floor' : `${(hopConfig?.ceilingBps ?? 0) / 100}%`}
                  </td>
                  <td className="py-1 pr-4">{hopConfig ? formatUsdc(hopConfig.capUsdc) : '-'}</td>
                  <td className="py-1 pr-4">
                    {hop === 0 ? `${stats.whitelistCount}/${CROWDFUND_CONSTANTS.MAX_SEEDS}` : stats.whitelistCount}
                  </td>
                  <td className="py-1 pr-4">{stats.uniqueCommitters}</td>
                  <td className="py-1 pr-4">{formatUsdc(stats.totalCommitted)}</td>
                  <td className="py-1 pr-4">{formatUsdc(stats.cappedCommitted)}</td>
                  <td className={`py-1 pr-4 font-medium ${overUnderColor}`}>
                    {overUnderPct.toFixed(1)}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* LT budget tracker (launch team only) */}
      {role === 'launch_team' && (
        <div className="rounded border border-border p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Launch Team Budget</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-muted-foreground">Hop-1 remaining: </span>
              <span className="font-medium">{state.ltBudgetHop1Remaining} / {CROWDFUND_CONSTANTS.LAUNCH_TEAM_HOP1_BUDGET}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Hop-2 remaining: </span>
              <span className="font-medium">{state.ltBudgetHop2Remaining} / {CROWDFUND_CONSTANTS.LAUNCH_TEAM_HOP2_BUDGET}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

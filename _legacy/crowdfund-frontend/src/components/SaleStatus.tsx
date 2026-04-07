// ABOUTME: Sale status dashboard showing phase, timing, progress, and per-hop stats.
// ABOUTME: Reads from crowdfund state atom and displays the current phase.
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Phase, CROWDFUND_CONSTANTS } from '@/types/crowdfund'
import { formatUsdc, formatCountdown, phaseName, phaseColor, hopLabel } from '@/utils/format'
import type { CrowdfundState } from '@/atoms/crowdfund'

interface SaleStatusProps {
  state: CrowdfundState
}

/**
 * Return the contract phase for display.
 * The contract phase maps directly to display state.
 */
function getEffectivePhase(state: CrowdfundState, _now: number): Phase {
  if (state.phase === null) return Phase.Active
  return state.phase
}

function getTimeRemaining(state: CrowdfundState, effectivePhase: Phase, now: number): string | null {
  if (effectivePhase === Phase.Active) {
    const end = Number(state.windowEnd)
    if (end > 0 && now < end) return formatCountdown(end - now)
    return 'expired — ready to finalize'
  }
  return null
}

export function SaleStatus({ state }: SaleStatusProps) {
  // Use chain block timestamp as the base — EVM time diverges from wall clock in local mode.
  // Increment locally every second for smooth countdowns between poll refreshes.
  const [elapsed, setElapsed] = useState(0)
  const baseTimestamp = state.blockTimestamp || Math.floor(Date.now() / 1000)
  const now = baseTimestamp + elapsed

  // Reset elapsed counter when blockTimestamp updates (from a poll refresh)
  useEffect(() => {
    setElapsed(0)
  }, [state.blockTimestamp])

  // Tick every second for smooth countdown display
  useEffect(() => {
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  if (state.phase === null) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading contract state...
        </CardContent>
      </Card>
    )
  }

  const effectivePhase = getEffectivePhase(state, now)
  const timeRemaining = getTimeRemaining(state, effectivePhase, now)

  // Progress calculation
  const committed = Number(state.totalCommitted) / 1e6
  const minSale = Number(CROWDFUND_CONSTANTS.MIN_SALE) / 1e6
  const maxSale = Number(CROWDFUND_CONSTANTS.MAX_SALE) / 1e6
  const progressPct = Math.min((committed / maxSale) * 100, 100)
  const minPct = (minSale / maxSale) * 100

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Sale Status</CardTitle>
          <div className="flex items-center gap-2">
            <Badge className={phaseColor(effectivePhase)}>
              {phaseName(effectivePhase)}
            </Badge>
            {timeRemaining && (
              <span className="text-sm text-muted-foreground">{timeRemaining}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>Total Committed: <span className="font-medium">{formatUsdc(state.totalCommitted)}</span></span>
            {state.saleSize > 0n && (
              <span className="text-muted-foreground">Sale Size: {formatUsdc(state.saleSize)}</span>
            )}
          </div>
          <div className="relative h-3 bg-muted rounded-full overflow-hidden">
            <div
              className="absolute h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
            {/* MIN_SALE marker */}
            <div
              className="absolute h-full w-px bg-warning"
              style={{ left: `${minPct}%` }}
              title={`Minimum: ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)}`}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>$0</span>
            <span className="text-warning">Min: {formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)}</span>
            <span>Max: {formatUsdc(CROWDFUND_CONSTANTS.MAX_SALE)}</span>
          </div>
        </div>

        {/* Hop stats table */}
        {state.hopStats && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hop</TableHead>
                <TableHead className="text-right">Reserve</TableHead>
                <TableHead className="text-right">Cap/Person</TableHead>
                <TableHead className="text-right">Whitelisted</TableHead>
                <TableHead className="text-right">Committers</TableHead>
                <TableHead className="text-right">Committed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.hopStats.map((hop, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{hopLabel(i)}</TableCell>
                  <TableCell className="text-right">{CROWDFUND_CONSTANTS.HOP_CEILING_BPS[i] / 100}%</TableCell>
                  <TableCell className="text-right">{formatUsdc(CROWDFUND_CONSTANTS.HOP_CAPS[i])}</TableCell>
                  <TableCell className="text-right">{hop.whitelistCount}</TableCell>
                  <TableCell className="text-right">{hop.uniqueCommitters}</TableCell>
                  <TableCell className="text-right">{formatUsdc(hop.totalCommitted)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

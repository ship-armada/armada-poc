// ABOUTME: Tests for ObserveStatusCard's per-hop Fill column on the committer Observe page.
// ABOUTME: Fill must be measured against the waterfall's effective ceilings, matching the contract.

import { render, screen, within } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import type { ContractState } from '@armada/crowdfund-shared'
import { ObserveStatusCard } from './ObserveStatusCard'

const USDC = (n: number) => BigInt(n) * 1_000_000n

function makeState(hopCapped: [number, number, number], overrides: Partial<ContractState> = {}): ContractState {
  const hopStats = hopCapped.map((c) => ({
    totalCommitted: USDC(c),
    cappedCommitted: USDC(c),
    whitelistCount: 0,
    uniqueCommitters: 0,
  }))
  const capped = hopStats.reduce((sum, h) => sum + h.cappedCommitted, 0n)
  return {
    phase: 0,
    armLoaded: true,
    totalCommitted: capped,
    cappedDemand: capped,
    saleSize: 0n,
    windowStart: 0,
    windowEnd: 0,
    launchTeamInviteEnd: 0,
    finalizedAt: 0,
    claimDeadline: 0,
    refundMode: false,
    blockTimestamp: 0,
    hopStats,
    participantCount: 0,
    seedCount: 0,
    loading: false,
    error: null,
    ...overrides,
  }
}

/** Fill cell (last column) of the given hop's row in the per-hop table. */
function fillCell(hop: number): string {
  const rows = screen.getAllByRole('row')
  // rows[0] is the header row.
  const cells = within(rows[hop + 1]).getAllByRole('cell')
  return cells[cells.length - 1].textContent ?? ''
}

describe('ObserveStatusCard per-hop Fill', () => {
  // WHY: at BASE_SALE hop-0's effective ceiling is $564k (60% of the 95% base pool,
  // less the 10% extra hop-2 floor). $600k is oversubscribed — a naive
  // saleSize × ceilingBps ceiling ($720k) would show a misleading 83%.
  // WHY: FUNDED and LEFT measure progress toward the funding goal (on the mainnet profile the goal
  // is its $1M minimum), with the goal and minimum as their own stats.
  it('measures FUNDED and LEFT against the goal and shows the goal and minimum as stats', () => {
    render(<ObserveStatusCard state={makeState([450_000, 0, 0])} />)
    expect(screen.getByText('FUNDED').parentElement?.textContent).toBe('45%FUNDED')
    expect(screen.getByText('LEFT').parentElement?.textContent).toBe('$550,000LEFT')
    expect(screen.getByText('GOAL').parentElement?.textContent).toBe('$1,000,000GOAL')
    expect(screen.getByText('MIN').parentElement?.textContent).toBe('$1,000,000MIN')
  })

  // WHY: commitments can run past the goal, so FUNDED passes 100% and LEFT is hidden.
  it('lets FUNDED pass 100% and hides LEFT past the goal', () => {
    render(<ObserveStatusCard state={makeState([2_100_000, 0, 0])} />)
    expect(screen.getByText('FUNDED').parentElement?.textContent).toBe('210%FUNDED')
    expect(screen.queryByText('LEFT')).toBeNull()
  })

  it('measures hop-0 against its effective waterfall ceiling before finalization', () => {
    render(<ObserveStatusCard state={makeState([600_000, 0, 0])} />)
    expect(fillCell(0)).toBe('106%')
  })

  // WHY: hop-1's ceiling is boosted by hop-0's unused capacity (bounded by the pool left
  // after hop-0): $513k + $264k, capped at $720k. $600k therefore fits — a naive
  // saleSize × ceilingBps ceiling ($540k) would wrongly flag it as oversubscribed.
  it('measures hop-1 against its rollover-boosted ceiling', () => {
    render(<ObserveStatusCard state={makeState([300_000, 600_000, 0])} />)
    expect(fillCell(1)).toBe('83%')
  })

  it('uses the finalized sale size once set', () => {
    render(<ObserveStatusCard state={makeState([600_000, 0, 0], { phase: 1, saleSize: USDC(1_200_000) })} />)
    expect(fillCell(0)).toBe('106%')
  })

  // WHY: Launch 1's sale could expand, so the projected sale size (and BASE / EXPANDED) still informs.
  it('keeps the projected sale size where the sale can expand', () => {
    render(<ObserveStatusCard state={makeState([450_000, 0, 0])} />)
    expect(screen.getByText(/Projected size/)).toBeTruthy()
  })
})

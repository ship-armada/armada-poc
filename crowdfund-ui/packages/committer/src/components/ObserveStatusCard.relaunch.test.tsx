// ABOUTME: Tests for ObserveStatusCard under the relaunch profile: no Team row, reserve/remainder labels,
// ABOUTME: no expansion badge, and fill measured against each tier's capacity. Mocks the shared profile values.

import { render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { formatUsdc, type ContractState } from '@armada/crowdfund-shared'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return {
    ...actual,
    CROWDFUND_CONSTANTS: actual.CONSTANTS_BY_PROFILE.relaunch,
    HOP_CONFIGS: actual.HOP_CONFIGS_BY_PROFILE.relaunch,
    CROWDFUND_FEATURES: actual.FEATURES_BY_PROFILE.relaunch,
    TIER_NOUN: actual.TIER_NOUN_BY_PROFILE.relaunch,
    hopLabel: (hop: number) => actual.TIER_LABELS_BY_PROFILE.relaunch[hop] ?? `Hop-${hop}`,
  }
})

import { ObserveStatusCard } from './ObserveStatusCard'

const USDC = (n: number) => BigInt(n) * 1_000_000n

function makeState(hopCapped: [number, number, number]): ContractState {
  const hopStats = hopCapped.map((c) => ({
    totalCommitted: USDC(c),
    cappedCommitted: USDC(c),
    whitelistCount: 0,
    uniqueCommitters: 0,
  }))
  const capped = hopStats.reduce((sum, h) => sum + h.cappedCommitted, 0n)
  return {
    phase: 0, armLoaded: true, totalCommitted: capped, cappedDemand: capped, saleSize: 0n,
    windowStart: 0, windowEnd: 0, launchTeamInviteEnd: 0, finalizedAt: 0, claimDeadline: 0,
    refundMode: false, blockTimestamp: 0, hopStats, participantCount: 0, seedCount: 0,
    loading: false, error: null,
  }
}

/** Cells of the per-hop table row whose first cell names `tier`. */
function rowCells(tier: string): string[] {
  const row = screen.getAllByRole('row').find((r) => within(r).queryAllByRole('cell')[0]?.textContent === tier)
  if (!row) throw new Error(`no row for ${tier}`)
  return within(row).getAllByRole('cell').map((c) => c.textContent ?? '')
}

describe('ObserveStatusCard on the relaunch profile', () => {
  // WHY: team inviter wallets are hidden from public views, so their (always $0) hop-1 row must not
  // appear; the public sale has two tiers.
  it('shows only the Known and Invited tiers', () => {
    render(<ObserveStatusCard state={makeState([300_000, 0, 50_000])} />)
    expect(screen.getByRole('columnheader', { name: 'Tier' })).toBeTruthy()
    const tiers = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)
    expect(tiers).toEqual(['Known', 'Invited'])
  })

  // WHY: the relaunch has no bps ceilings, hop-2 floor or expansion: the Invited tier has a $300K
  // reserve and Known takes the remainder. Fill is demand against the most a tier could absorb (its
  // allocation plus the $1.45M still unallocated), so an undersubscribed tier reads well below 100%.
  it('labels the reserve and remainder, measures fill against capacity, and drops the sale-size badge', () => {
    render(<ObserveStatusCard state={makeState([300_000, 0, 50_000])} />)
    const invited = rowCells('Invited')
    expect(invited[1]).toBe('$300K reserve')
    expect(invited[invited.length - 1]).toBe('3%') // $50k of $50k + $1.45M
    const known = rowCells('Known')
    expect(known[1]).toBe('Remainder')
    expect(known[known.length - 1]).toBe('17%') // $300k of $300k + $1.45M
    expect(screen.queryByText(/BASE|EXPANDED/)).toBeNull()
  })

  // WHY: the reserve means Known demand that fills the sale cannot crowd the Invited tier out: its
  // $10K is allocated in full (fill 100%), and Known is pro-rated into the rest.
  it('keeps the Invited tier inside its reserve when Known demand fills the sale', () => {
    render(<ObserveStatusCard state={makeState([1_800_000, 0, 10_000])} />)
    const invited = rowCells('Invited')
    expect(invited[7]).toBe(formatUsdc(USDC(10_000))) // Est. alloc
    expect(invited[invited.length - 1]).toBe('100%')
    const known = rowCells('Known')
    expect(known[7]).toBe(formatUsdc(USDC(1_790_000)))
    expect(known[known.length - 1]).toBe('101%') // $1.8M of $1.79M: pro-rated
  })

  // WHY: the relaunch presents a $750K goal as "100% funded" on a bar that runs to the $1.8M
  // maximum; the $250K minimum stays visible here as a detail stat only.
  it('measures progress toward the $750K goal and lists the goal and minimum', () => {
    render(<ObserveStatusCard state={makeState([300_000, 0, 150_000])} />)
    expect(screen.getByText('FUNDED').parentElement?.textContent).toBe('60%FUNDED')
    expect(screen.getByText('LEFT').parentElement?.textContent).toBe('$300,000LEFT')
    expect(screen.getByText('GOAL').parentElement?.textContent).toBe('$750,000GOAL')
    expect(screen.getByText('MIN').parentElement?.textContent).toBe('$250,000MIN')
  })
})

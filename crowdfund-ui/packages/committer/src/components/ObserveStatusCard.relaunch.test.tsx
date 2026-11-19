// ABOUTME: Tests for ObserveStatusCard under the relaunch profile: no Team row, no floor/expansion labels,
// ABOUTME: and hop-2 fill measured against its rollover ceiling. Mocks the shared profile values.

import { render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ContractState } from '@armada/crowdfund-shared'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return {
    ...actual,
    CROWDFUND_CONSTANTS: actual.CONSTANTS_BY_PROFILE.relaunch,
    HOP_CONFIGS: actual.HOP_CONFIGS_BY_PROFILE.relaunch,
    CROWDFUND_FEATURES: actual.FEATURES_BY_PROFILE.relaunch,
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
    const tiers = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)
    expect(tiers).toEqual(['Known', 'Invited'])
  })

  // WHY: there is no hop-2 floor and no expansion on the relaunch; "Floor" and "BASE"/"EXPANDED"
  // would describe mechanics the sale does not have.
  it('labels hop 2 as rollover and drops the sale-size badge', () => {
    render(<ObserveStatusCard state={makeState([300_000, 0, 50_000])} />)
    const invited = rowCells('Invited')
    expect(invited[1]).toBe('Rollover')
    expect(invited[invited.length - 1]).toBe('4%') // $50k of the $1.2M left after Known
    expect(screen.queryByText(/BASE|EXPANDED/)).toBeNull()
  })

  // WHY: when Known demand fills the sale the Invited tier's rollover ceiling is $0; a fill
  // percentage is meaningless there, so the cell shows a dash rather than a misleading 0%.
  it('shows a dash for Invited fill when the tier is crowded out', () => {
    render(<ObserveStatusCard state={makeState([1_500_000, 0, 10_000])} />)
    const invited = rowCells('Invited')
    expect(invited[invited.length - 1]).toBe('—')
  })
})

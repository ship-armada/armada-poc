// ABOUTME: Tests the committer's Details participants table under the relaunch profile (mocked): the team-wallet
// ABOUTME: disclosure, and tier wording (Tier / Known / Invited) in the filters, toggle and headers instead of hops.

import { render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return {
    ...actual,
    CROWDFUND_FEATURES: actual.FEATURES_BY_PROFILE.relaunch,
    TIER_NOUN: actual.TIER_NOUN_BY_PROFILE.relaunch,
    hopLabel: (hop: number) => actual.TIER_LABELS_BY_PROFILE.relaunch[hop] ?? `Hop-${hop}`,
  }
})

import { ObserveParticipantsTable, TEAM_WALLET_DISCLOSURE } from './ObserveParticipantsTable'

// The table resolves ENS names through react-query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

describe('ObserveParticipantsTable team-wallet disclosure', () => {
  // WHY: the team wallets stay visible on-chain and on block explorers. Without this note, someone
  // comparing the app to Etherscan would wonder why addresses are missing.
  it('explains that team-operated wallets are not listed', () => {
    render(<ObserveParticipantsTable events={[]} phase={0} provider={null} />, { wrapper })
    expect(screen.getByText(TEAM_WALLET_DISCLOSURE)).toBeTruthy()
  })

  // WHY: the relaunch presents its hops as named tiers; the filter must offer those tiers (not
  // Hop-0/1/2), and not the Team tier, whose wallets this table hides.
  it('filters by tier, without the hidden Team tier', () => {
    render(<ObserveParticipantsTable events={[]} phase={0} provider={null} />, { wrapper })
    const options = within(screen.getByLabelText('Tier filter')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['All tiers', 'Known', 'Invited'])
  })

  // WHY: the view toggle and column header name tiers too, so no "hop" wording reaches participants.
  it('names the per-tier view and column', () => {
    render(<ObserveParticipantsTable events={[]} phase={0} provider={null} />, { wrapper })
    expect(screen.getByRole('button', { name: 'Per tier' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /^Tier/ })).toBeTruthy()
    expect(screen.queryByText(/hop/i)).toBeNull()
  })

  // WHY: "Invited only" (invited, not yet committed) read as "the Invited tier only" once Invited
  // became a tier name; the option says what it filters.
  it('labels the uncommitted status option "Not committed"', () => {
    render(<ObserveParticipantsTable events={[]} phase={0} provider={null} />, { wrapper })
    const options = within(screen.getByLabelText('Status filter')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('Not committed')
    expect(options).not.toContain('Invited only')
  })
})

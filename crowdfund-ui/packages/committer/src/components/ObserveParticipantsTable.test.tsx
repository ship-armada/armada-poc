// ABOUTME: Tests for the committer Details participants table on the default (mainnet) profile.
// ABOUTME: The team-wallet disclosure appears only on profiles that hide team inviter wallets.

import { render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect } from 'vitest'
import { ObserveParticipantsTable, TEAM_WALLET_DISCLOSURE } from './ObserveParticipantsTable'

// The table resolves ENS names through react-query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

describe('ObserveParticipantsTable on the mainnet profile', () => {
  // WHY: Launch 1 shows the real hop structure, so there is nothing hidden to disclose.
  it('does not show the team-wallet disclosure', () => {
    render(<ObserveParticipantsTable events={[]} phase={0} provider={null} />, { wrapper })
    expect(screen.queryByText(TEAM_WALLET_DISCLOSURE)).toBeNull()
  })

  // WHY: Launch 1 numbers its hops; its filter keeps every hop, Team included.
  it('keeps hop wording and all three hops in the filter', () => {
    render(<ObserveParticipantsTable events={[]} phase={0} provider={null} />, { wrapper })
    const options = within(screen.getByLabelText('Hop filter')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['All hops', 'Hop-0', 'Hop-1', 'Hop-2'])
    expect(screen.getByRole('button', { name: 'Per hop' })).toBeTruthy()
  })
})

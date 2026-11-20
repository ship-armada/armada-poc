// ABOUTME: Tests the team-wallet disclosure on the committer's Details participants table: shown only on
// ABOUTME: profiles that hide team inviter wallets (mocked here), so the hidden wallets are explained.

import { render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return { ...actual, CROWDFUND_FEATURES: actual.FEATURES_BY_PROFILE.relaunch }
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
})

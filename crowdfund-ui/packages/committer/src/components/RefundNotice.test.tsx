// ABOUTME: Tests for the first-sale refund notices: the pre-launch line and the live banner for eligible wallets.
// ABOUTME: Mocks the refund address config and the refund read hook.
// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RefundOnlyClaimState } from '@/lib/refundOnlyClaim'

const REFUND_TARGET = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const m = vi.hoisted(() => ({
  address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as string | null,
  state: null as RefundOnlyClaimState | null,
  hookWallet: undefined as string | null | undefined,
}))

vi.mock('@/config/refundOnly', () => ({ getRefundOnlyCrowdfundAddress: () => m.address }))
vi.mock('@/hooks/useRefundOnlyClaim', () => ({
  useRefundOnlyClaim: (wallet: string | null) => {
    m.hookWallet = wallet
    return { crowdfundAddress: m.address, provider: null, state: m.state, loading: false, refetch: vi.fn() }
  },
}))

import { EligibleRefundNotice, PrelaunchRefundNotice } from './RefundNotice'

const WALLET = '0x1111111111111111111111111111111111111111'
const LIVE_CROWDFUND = '0x9999999999999999999999999999999999999999'

const inRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('PrelaunchRefundNotice', () => {
  beforeEach(() => {
    m.address = REFUND_TARGET
  })

  // WHY: before the sale opens no wallet is connected, so the line is shown to everyone who can
  // land on the countdown; it links to the /refund page.
  it('links everyone to /refund while the feature is on', () => {
    inRouter(<PrelaunchRefundNotice />)
    const link = screen.getByRole('link', { name: /claim your refund/i })
    expect(link.getAttribute('href')).toBe('/refund')
  })

  it('renders nothing when the network has no first sale', () => {
    m.address = null
    const { container } = inRouter(<PrelaunchRefundNotice />)
    expect(container.textContent).toBe('')
  })
})

describe('EligibleRefundNotice', () => {
  beforeEach(() => {
    m.address = REFUND_TARGET
    m.state = null
  })

  // WHY: on the live app the banner is only for wallets that have a refund waiting.
  it('shows the amount and a link to /refund for an eligible wallet', () => {
    m.state = { kind: 'eligible', amount: 33_000_000_000n }
    inRouter(<EligibleRefundNotice walletAddress={WALLET} activeCrowdfundAddress={LIVE_CROWDFUND} />)
    expect(screen.getByText(/You still have \$33,000 USDC/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /claim refund/i }).getAttribute('href')).toBe('/refund')
    expect(m.hookWallet).toBe(WALLET)
  })

  it('stays hidden for every other state', () => {
    for (const state of [null, { kind: 'none' }, { kind: 'claimed', amount: 1n }, { kind: 'unavailable' }, { kind: 'error' }] as const) {
      m.state = state as RefundOnlyClaimState | null
      const { container, unmount } = inRouter(
        <EligibleRefundNotice walletAddress={WALLET} activeCrowdfundAddress={LIVE_CROWDFUND} />,
      )
      expect(container.textContent).toBe('')
      unmount()
    }
  })

  // WHY: if the live app were ever pointed at the first-sale contract itself, the banner would send
  // users to refund the sale they are looking at; never show it then.
  it('stays hidden when the live crowdfund is the refund target', () => {
    m.state = { kind: 'eligible', amount: 1_000_000n }
    const { container } = inRouter(
      <EligibleRefundNotice walletAddress={WALLET} activeCrowdfundAddress={REFUND_TARGET.toLowerCase()} />,
    )
    expect(container.textContent).toBe('')
  })
})

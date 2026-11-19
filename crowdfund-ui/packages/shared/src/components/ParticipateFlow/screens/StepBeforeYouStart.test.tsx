// ABOUTME: Tests for StepBeforeYouStart's Useful links — the Contract tile must point at the real deployment.
// ABOUTME: Without a deployed address + explorer, the tile is omitted rather than linking a placeholder.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import StepBeforeYouStart, { allocationBullet } from './StepBeforeYouStart.js'

const CROWDFUND = '0x' + 'c'.repeat(40)

describe('StepBeforeYouStart Contract link', () => {
  it('links the Contract tile to the deployed crowdfund on the given explorer', () => {
    render(
      <StepBeforeYouStart
        onBack={vi.fn()}
        onContinue={vi.fn()}
        contractAddress={CROWDFUND}
        explorerBaseUrl="https://etherscan.io"
      />,
    )
    const link = screen.getByRole('link', { name: /Contract/ })
    expect(link.getAttribute('href')).toBe(`https://etherscan.io/address/${CROWDFUND}`)
  })

  it('omits the Contract tile when no contract address is known', () => {
    render(
      <StepBeforeYouStart onBack={vi.fn()} onContinue={vi.fn()} explorerBaseUrl="https://etherscan.io" />,
    )
    expect(screen.queryByRole('link', { name: /Contract/ })).toBeNull()
    // The other resource links still render.
    expect(screen.getByRole('link', { name: /Website/ })).toBeTruthy()
  })

  it('omits the Contract tile when the network has no block explorer', () => {
    render(<StepBeforeYouStart onBack={vi.fn()} onContinue={vi.fn()} contractAddress={CROWDFUND} />)
    expect(screen.queryByRole('link', { name: /Contract/ })).toBeNull()
  })
})

describe('StepBeforeYouStart resource links', () => {
  it('links Discord and X to the canonical Armada accounts', () => {
    render(<StepBeforeYouStart onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByRole('link', { name: /Discord/ }).getAttribute('href')).toBe(
      'https://armada.blue/discord',
    )
    expect(screen.getByRole('link', { name: /^X\b/ }).getAttribute('href')).toBe(
      'https://x.com/ship_armada',
    )
  })
})

describe('StepBeforeYouStart refund threshold', () => {
  afterEach(() => {
    vi.doUnmock('../../../lib/constants')
    vi.resetModules()
  })

  it('states the mainnet minimum raise by default', () => {
    render(<StepBeforeYouStart onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText(/If the raise ends under \$1,000,000, everyone gets a full refund\./)).toBeTruthy()
  })

  it('states the active profile\'s minimum raise (e.g. medi: $800)', async () => {
    // The profile is fixed at build time, so swap the constants module in directly.
    vi.doMock('../../../lib/constants', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../lib/constants')>()
      return {
        ...actual,
        CROWDFUND_CONSTANTS: { ...actual.CROWDFUND_CONSTANTS, MIN_SALE: 800n * 10n ** 6n },
      }
    })
    vi.resetModules()
    const { default: MediStep } = await import('./StepBeforeYouStart.js')
    render(<MediStep onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText(/If the raise ends under \$800, everyone gets a full refund\./)).toBeTruthy()
  })
})

describe('allocationBullet', () => {
  // WHY: under priority fill (the relaunch) a tier can be refunded in full even when it is not itself
  // oversubscribed, so the "if your hop is oversubscribed" wording is wrong there; the decided copy
  // says the allocation may be reduced or none.
  it('uses the reduced-or-none wording with the sale size under priority fill', () => {
    expect(allocationBullet(true, 1_500_000_000_000n)).toBe(
      'Allocation isn’t guaranteed. If total demand exceeds the $1.5M sale, you may receive a reduced allocation or none, and the rest comes back to you.',
    )
  })

  it('keeps the per-hop pro-rata wording otherwise', () => {
    expect(allocationBullet(false, 1_200_000_000_000n)).toBe(
      'Allocation isn’t guaranteed. If your hop is oversubscribed you get a pro-rata share and the rest comes back to you.',
    )
  })
})

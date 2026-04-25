// ABOUTME: Tests for CommitTab component — eligibility, window states, validation, step nav.
// ABOUTME: Walks through the context → amount → review flow.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CommitTab } from './CommitTab'
import type { CommitTabProps } from './CommitTab'
import type { HopPosition } from '@/hooks/useEligibility'
import type { HopStatsData } from '@armada/crowdfund-shared'

const USDC = 10n ** 6n

const defaultHopStats: HopStatsData[] = [
  { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
  { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
  { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
]

function makePosition(overrides: Partial<HopPosition> = {}): HopPosition {
  return {
    hop: 0,
    invitesReceived: 1,
    committed: 0n,
    effectiveCap: 15_000n * USDC,
    remaining: 15_000n * USDC,
    invitesUsed: 0,
    invitesAvailable: 3,
    invitedBy: ['armada'],
    ...overrides,
  }
}

function renderCommitTab(overrides: Partial<CommitTabProps> = {}) {
  const defaultProps: CommitTabProps = {
    positions: [makePosition()],
    eligible: true,
    balance: 50_000n * USDC,
    needsApproval: () => false,
    refreshAllowance: vi.fn(),
    signer: null,
    crowdfundAddress: '0x1234567890abcdef1234567890abcdef12345678',
    usdcAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    hopStats: defaultHopStats,
    saleSize: 1_200_000n * USDC,
    phase: 0,
    windowOpen: true,
    resolveENS: () => null,
    ...overrides,
  }
  return render(<CommitTab {...defaultProps} />)
}

/** Click the primary "Continue" button on the current step. */
function clickContinue() {
  const continueBtn = screen.getAllByRole('button', { name: 'Continue' })
  // The first matching enabled button is the step's primary CTA.
  const target = continueBtn.find((b) => !(b as HTMLButtonElement).disabled) ?? continueBtn[0]
  fireEvent.click(target)
}

describe('CommitTab', () => {
  it('shows not-eligible message when not eligible', () => {
    renderCommitTab({ eligible: false, positions: [] })
    expect(screen.getByText('Not Eligible')).toBeInTheDocument()
  })

  it('shows window-closed message when phase !== 0', () => {
    renderCommitTab({ phase: 1 })
    expect(screen.getByText('Commitment window is closed.')).toBeInTheDocument()
  })

  it('shows window-not-open message when windowOpen is false', () => {
    renderCommitTab({ windowOpen: false })
    expect(screen.getByText('Commitment window is not yet open.')).toBeInTheDocument()
  })

  it('lands on the context step with eligibility info and inviter attribution', () => {
    renderCommitTab()
    expect(screen.getByText('Your positions')).toBeInTheDocument()
    expect(screen.getByText(/invited by Armada/)).toBeInTheDocument()
    // hopLabel(0) appears on this step
    expect(screen.getAllByText('Seed (hop-0)').length).toBeGreaterThanOrEqual(1)
  })

  it('advances to the amount step and renders per-hop input cards', () => {
    renderCommitTab()
    clickContinue()
    expect(screen.getByLabelText(/Commit amount/)).toBeInTheDocument()
    expect(screen.getAllByText('Seed (hop-0)').length).toBeGreaterThanOrEqual(1)
  })

  it('renders multiple hop inputs for multi-position user', () => {
    renderCommitTab({
      positions: [
        makePosition({ hop: 0 }),
        makePosition({
          hop: 1,
          effectiveCap: 8_000n * USDC,
          remaining: 8_000n * USDC,
          invitedBy: ['0x1234567890abcdef1234567890abcdef12345678'],
        }),
      ],
    })
    clickContinue()
    expect(screen.getAllByText('Seed (hop-0)').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Hop-1').length).toBeGreaterThanOrEqual(1)
  })

  it('shows cap reached warning when remaining is 0', () => {
    renderCommitTab({
      positions: [makePosition({ remaining: 0n })],
    })
    clickContinue()
    expect(screen.getByText('Cap reached at this hop')).toBeInTheDocument()
  })

  it('disables the amount-step Continue button when no amounts entered', () => {
    renderCommitTab()
    clickContinue()
    // Now on amount step. There's only one Continue button visible — the
    // step footer's primary CTA, which should be disabled until input.
    const continueBtns = screen.getAllByRole('button', { name: 'Continue' })
    expect(continueBtns[continueBtns.length - 1]).toBeDisabled()
  })

  it('enables the amount-step Continue button after typing a valid amount', async () => {
    renderCommitTab()
    clickContinue()
    const continueBtns = screen.getAllByRole('button', { name: 'Continue' })
    const cta = continueBtns[continueBtns.length - 1]
    expect(cta).toBeDisabled()
    const input = screen.getByLabelText(/Commit amount/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    await waitFor(() => expect(cta).not.toBeDisabled())
  })

  it('enables Continue after typing even when balance loads async (useAllowance race)', async () => {
    const { rerender } = renderCommitTab({ balance: 0n })
    rerender(
      <CommitTab
        {...({
          positions: [makePosition()],
          eligible: true,
          balance: 50_000n * USDC,
          needsApproval: () => false,
          refreshAllowance: vi.fn(),
          signer: null,
          crowdfundAddress: '0x1234567890abcdef1234567890abcdef12345678',
          usdcAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
          hopStats: defaultHopStats,
          saleSize: 1_200_000n * USDC,
          phase: 0,
          windowOpen: true,
          resolveENS: () => null,
        } as CommitTabProps)}
      />,
    )
    clickContinue()
    const continueBtns = screen.getAllByRole('button', { name: 'Continue' })
    const cta = continueBtns[continueBtns.length - 1]
    const input = screen.getByLabelText(/Commit amount/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    await waitFor(() => expect(cta).not.toBeDisabled(), { timeout: 1500 })
  })
})

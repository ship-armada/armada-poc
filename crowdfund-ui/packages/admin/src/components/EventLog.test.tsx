// ABOUTME: Tests for EventLog component — filtering, tx hash links, pagination.
// ABOUTME: Verifies event display, type filtering, explorer links, and load-more behavior.

import { render, screen, fireEvent } from '@testing-library/react'
import { EventLog } from './EventLog'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'

// Mock network config
vi.mock('@/config/network', () => ({
  getExplorerUrl: () => 'https://sepolia.etherscan.io',
}))

const ADDR = '0x1111111111111111111111111111111111111111'

function makeEvent(type: CrowdfundEvent['type'], blockNumber: number, txHash?: string): CrowdfundEvent {
  const argsByType: Record<string, Record<string, unknown>> = {
    SeedAdded: { seed: ADDR },
    Committed: { participant: ADDR, hop: 0, amount: 1000n * 10n ** 6n },
    Invited: { inviter: ADDR, invitee: ADDR, hop: 1 },
    Finalized: { saleSize: 1_200_000n * 10n ** 6n, refundMode: false },
    Allocated: { participant: ADDR, armTransferred: 1000n * 10n ** 18n },
    RefundClaimed: { participant: ADDR, usdcAmount: 500n * 10n ** 6n },
  }
  return {
    type,
    args: argsByType[type] ?? {},
    blockNumber,
    logIndex: 0,
    transactionHash: txHash ?? `0x${'ab'.repeat(32)}`,
  }
}

describe('EventLog', () => {
  it('renders event count', () => {
    const events = [makeEvent('SeedAdded', 1)]
    render(<EventLog events={events} loading={false} />)
    expect(screen.getByText('1 events')).toBeInTheDocument()
  })

  it('shows syncing indicator when loading', () => {
    render(<EventLog events={[]} loading={true} />)
    expect(screen.getByText(/syncing/i)).toBeInTheDocument()
  })

  it('shows "No events" when empty', () => {
    render(<EventLog events={[]} loading={false} />)
    expect(screen.getByText('No events')).toBeInTheDocument()
  })

  it('renders tx hash as explorer link', () => {
    const txHash = `0x${'cd'.repeat(32)}`
    const events = [makeEvent('SeedAdded', 1, txHash)]
    render(<EventLog events={events} loading={false} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', `https://sepolia.etherscan.io/tx/${txHash}`)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('filters events by type toggle', () => {
    const events = [
      makeEvent('SeedAdded', 1),
      makeEvent('Committed', 2),
    ]
    render(<EventLog events={events} loading={false} />)
    expect(screen.getByText(/2 events/)).toBeInTheDocument()

    // Toggle off SeedAdded
    const seedButton = screen.getByRole('button', { name: 'SeedAdded' })
    fireEvent.click(seedButton)
    expect(screen.getByText(/1 events/)).toBeInTheDocument()
  })

  it('paginates events with load more button', () => {
    // Create 250 events
    const events = Array.from({ length: 250 }, (_, i) => makeEvent('SeedAdded', i))
    render(<EventLog events={events} loading={false} />)

    // Should show load more button
    expect(screen.getByText(/load more/i)).toBeInTheDocument()
    expect(screen.getByText(/50 remaining/i)).toBeInTheDocument()
  })
})

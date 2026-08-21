// ABOUTME: Tests for ActivityReceipt — reconstructs a past tx's confirm-step summary from its record.
// ABOUTME: Covers the title/amount + a summary row for a deposit, and that null record renders nothing.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ActivityReceipt } from './ActivityReceipt'
import type { TxRecord } from '@/lib/tx/types'

function shieldRecord(): TxRecord {
  return {
    id: 'rec-1',
    kind: 'shield',
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof', 'submit-relayer', 'hub-confirmed'],
    executionState: 'completed',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_050_000,
    walletContext: { sourceChainId: 31337 },
    meta: { amount: 100_500_000n, fromChainId: 31337, feeCacheId: 'x' },
    artifacts: {},
  } as unknown as TxRecord
}

describe('<ActivityReceipt>', () => {
  it('renders nothing when record is null', () => {
    render(<ActivityReceipt record={null} open onClose={vi.fn()} />)
    expect(screen.queryByText('USDC shield')).toBeNull()
  })

  it('shows the deposit title + amount + a summary row', () => {
    render(<ActivityReceipt record={shieldRecord()} open onClose={vi.fn()} />)
    expect(screen.getByText('USDC shield')).toBeInTheDocument()
    expect(screen.getByText('100.5')).toBeInTheDocument()
    // The reused DepositReviewSummary surfaces the confirmed "Date and time" row.
    expect(screen.getByText('Date and time')).toBeInTheDocument()
  })

  it('disables View on explorer without a source tx hash', () => {
    render(<ActivityReceipt record={shieldRecord()} open onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'View on explorer' })).toBeDisabled()
  })

  it('fires onClose from the Done CTA after the exit animation', async () => {
    const onClose = vi.fn()
    render(<ActivityReceipt record={shieldRecord()} open onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    // Close is deferred until the slide-down exit finishes.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})

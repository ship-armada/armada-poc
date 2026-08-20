// ABOUTME: Render/interaction test for the ActivityAllPanel — filtering to nothing shows the empty state.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActivityAllPanel } from './ActivityAllPanel'
import type { DashboardActivityItem } from '@/components/dashboard/txActivityAdapter'

const items: DashboardActivityItem[] = [
  {
    id: 'a',
    kind: 'deposit',
    label: 'Deposit from Base',
    amount: 5,
    occurredAt: Date.now(),
    txHash: '0xaaa111',
    pending: false,
  },
  {
    id: 'b',
    kind: 'send',
    label: 'Private transfer',
    amount: -2,
    occurredAt: Date.now(),
    txHash: '0xbbb222',
    pending: false,
  },
]

describe('ActivityAllPanel', () => {
  it('renders the filtered activity list when open', () => {
    render(<ActivityAllPanel open onClose={() => {}} items={items} />)
    expect(screen.getByText('Deposit from Base')).toBeInTheDocument()
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
  })

  it('shows the empty state when the search excludes everything', () => {
    render(<ActivityAllPanel open onClose={() => {}} items={items} />)
    fireEvent.change(screen.getByLabelText('Search by transaction hash'), {
      target: { value: '0xnope' },
    })
    expect(screen.getByText('No transactions match your filters.')).toBeInTheDocument()
    expect(screen.queryByText('Deposit from Base')).not.toBeInTheDocument()
  })

  it('filters by kind chip', () => {
    render(<ActivityAllPanel open onClose={() => {}} items={items} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Withdraw' }))
    expect(screen.getByText('No transactions match your filters.')).toBeInTheDocument()
  })

  it('shows the "showing latest N" note only when truncatedCount is set', () => {
    const { rerender } = render(<ActivityAllPanel open onClose={() => {}} items={items} />)
    expect(screen.queryByText(/most recent transactions/)).toBeNull()
    rerender(<ActivityAllPanel open onClose={() => {}} items={items} truncatedCount={500} />)
    expect(screen.getByText('Showing your 500 most recent transactions.')).toBeInTheDocument()
  })
})

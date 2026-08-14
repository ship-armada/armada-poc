// ABOUTME: Render tests for the dashboard RecentActivityList — empty state, rows, pending subtitle, view-all + row clicks.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RecentActivityList } from './RecentActivityList'
import type { DashboardActivityItem } from '@/components/dashboard/txActivityAdapter'

const items: DashboardActivityItem[] = [
  { id: 'a', kind: 'deposit', label: 'Deposit', amount: 5, occurredAt: Date.now(), pending: false },
  { id: 'b', kind: 'send', label: 'Private transfer', amount: -2, occurredAt: Date.now(), pending: true },
]

describe('RecentActivityList', () => {
  it('shows the empty state when there are no items', () => {
    render(<RecentActivityList items={[]} />)
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
  })

  it('renders a row per item with its label', () => {
    render(<RecentActivityList items={items} />)
    expect(screen.getByText('Deposit')).toBeInTheDocument()
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
  })

  it('marks pending items with a "Pending" subtitle', () => {
    render(<RecentActivityList items={items} />)
    expect(screen.getByText(/^Pending •/)).toBeInTheDocument()
  })

  it('fires onViewAll when "View all" is clicked', () => {
    const onViewAll = vi.fn()
    render(<RecentActivityList items={items} onViewAll={onViewAll} />)
    fireEvent.click(screen.getByRole('button', { name: 'View all' }))
    expect(onViewAll).toHaveBeenCalledOnce()
  })

  it('fires onItemClick with the clicked item', () => {
    const onItemClick = vi.fn()
    render(<RecentActivityList items={items} onItemClick={onItemClick} />)
    fireEvent.click(screen.getByText('Deposit'))
    expect(onItemClick).toHaveBeenCalledWith(items[0])
  })
})

// ABOUTME: Render/interaction tests for the activity kind-filter chips — chips render and fire onChange.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActivityKindFilters } from './ActivityKindFilters'

describe('ActivityKindFilters', () => {
  it('renders every kind chip', () => {
    render(<ActivityKindFilters value="all" onChange={() => {}} />)
    for (const label of ['All', 'Deposit', 'Withdraw', 'Sent', 'Received']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }
  })

  it('marks the active chip as selected', () => {
    render(<ActivityKindFilters value="deposit" onChange={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Deposit' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false')
  })

  it('fires onChange with the chip id when clicked', () => {
    const onChange = vi.fn()
    render(<ActivityKindFilters value="all" onChange={onChange} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Sent' }))
    expect(onChange).toHaveBeenCalledWith('send')
  })
})

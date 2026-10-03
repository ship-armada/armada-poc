// ABOUTME: Tests for PageNav — Crowdfund / Your position / Claim tabs; Claim gated until open.
// ABOUTME: Also guards that social links stay out of the header nav.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PageNav } from './appNav'

describe('PageNav', () => {
  it('renders Crowdfund, Your position, and Claim', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Crowdfund' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Your position' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claim' })).toBeInTheDocument()
  })

  it('does not render The project', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'The project' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'The project' })).toBeNull()
  })

  it('disables Claim until claimEnabled', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <PageNav current="network" onChange={onChange} claimEnabled={false} />,
    )
    expect(screen.getByRole('button', { name: 'Claim' })).toBeDisabled()

    rerender(<PageNav current="network" onChange={onChange} claimEnabled />)
    expect(screen.getByRole('button', { name: 'Claim' })).toBeEnabled()
  })

  it('never marks Claim as the selected page tab', () => {
    render(<PageNav current="claim" onChange={vi.fn()} claimEnabled />)
    expect(screen.getByRole('button', { name: 'Claim' })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('no longer renders the social links in the header', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.queryByRole('link', { name: 'Armada on Discord' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Armada on X' })).toBeNull()
  })
})

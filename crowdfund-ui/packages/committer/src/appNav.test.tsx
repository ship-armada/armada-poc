// ABOUTME: Tests for PageNav — Crowdfund / My position / Claim tabs; Claim gated until open.
// ABOUTME: Social links no longer sit in the header (see FooterSocials.test.tsx).

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PageNav } from './appNav'

describe('PageNav', () => {
  it('renders Crowdfund, My position, and Claim', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Crowdfund' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My position' })).toBeInTheDocument()
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

  it('no longer renders the social links in the header', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.queryByRole('link', { name: 'Armada on Discord' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Armada on X' })).toBeNull()
  })
})

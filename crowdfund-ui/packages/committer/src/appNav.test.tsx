// ABOUTME: Tests for PageNav — confirms the Crowdfund nav renders and the social links no longer sit in the header.
// ABOUTME: The Discord/X links moved to the participate-flow invite footer (see FooterSocials.test.tsx).

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PageNav } from './appNav'

describe('PageNav', () => {
  it('renders the Crowdfund nav item', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.getByText('Crowdfund')).toBeInTheDocument()
  })

  it('no longer renders the social links in the header', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.queryByRole('link', { name: 'Armada on Discord' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Armada on X' })).toBeNull()
  })
})

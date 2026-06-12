// ABOUTME: Tests for PageNav — the header social links beside the Crowdfund nav.
// ABOUTME: Confirms Discord/X icon links render with the canonical URLs and open in new tabs.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PageNav } from './appNav'

describe('PageNav header socials', () => {
  it('renders Discord + X links beside the Crowdfund nav', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)

    const discord = screen.getByRole('link', { name: 'Armada on Discord' })
    expect(discord).toHaveAttribute('href', 'https://discord.gg/QcpeNenwhj')
    expect(discord).toHaveAttribute('target', '_blank')

    const x = screen.getByRole('link', { name: 'Armada on X' })
    expect(x).toHaveAttribute('href', 'https://x.com/ship_armada')
    expect(x).toHaveAttribute('target', '_blank')
  })
})

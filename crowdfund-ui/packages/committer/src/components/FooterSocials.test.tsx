// ABOUTME: Tests for FooterSocials — the Discord/X links shown beneath "Return" in the participate-flow invite card.
// ABOUTME: Confirms the icon links render with the canonical URLs and open in new tabs.

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { FooterSocials } from './FooterSocials'

describe('FooterSocials', () => {
  it('renders Discord + X links with the canonical URLs, opening in new tabs', () => {
    render(<FooterSocials />)

    const discord = screen.getByRole('link', { name: 'Armada on Discord' })
    expect(discord).toHaveAttribute('href', 'https://discord.gg/QcpeNenwhj')
    expect(discord).toHaveAttribute('target', '_blank')
    expect(discord).toHaveAttribute('rel', 'noopener noreferrer')

    const x = screen.getByRole('link', { name: 'Armada on X' })
    expect(x).toHaveAttribute('href', 'https://x.com/ship_armada')
    expect(x).toHaveAttribute('target', '_blank')
    expect(x).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

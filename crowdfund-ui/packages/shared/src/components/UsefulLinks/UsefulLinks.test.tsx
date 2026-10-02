// ABOUTME: Tests for UsefulLinks — each tile must open the canonical Armada destination.
// ABOUTME: Guards the Discord / X links against drifting from the shared socials constants.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { UsefulLinks } from './UsefulLinks.js'

describe('UsefulLinks', () => {
  it('links Discord and X to the canonical Armada accounts', () => {
    render(<UsefulLinks />)
    expect(screen.getByRole('link', { name: /Discord/ }).getAttribute('href')).toBe(
      'https://discord.com/invite/ship-armada',
    )
    expect(screen.getByRole('link', { name: /Twitter/ }).getAttribute('href')).toBe(
      'https://x.com/ship_armada',
    )
  })
})

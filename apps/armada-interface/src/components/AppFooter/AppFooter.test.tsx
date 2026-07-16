// ABOUTME: Tests for AppFooter — renders the configured social/homepage links with safe external-link attrs.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppFooter } from './AppFooter'

describe('<AppFooter>', () => {
  it('renders Discord, X, and Website links with their URLs', () => {
    render(<AppFooter />)
    expect(screen.getByRole('link', { name: 'Discord' })).toHaveAttribute('href', 'https://discord.gg/NxDyA2EDm')
    expect(screen.getByRole('link', { name: 'X (Twitter)' })).toHaveAttribute('href', 'https://x.com/ship_armada')
    expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute('href', 'https://armada.wtf')
  })

  it('opens links in a new tab with noopener noreferrer (reverse-tabnabbing safe)', () => {
    render(<AppFooter />)
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })
})

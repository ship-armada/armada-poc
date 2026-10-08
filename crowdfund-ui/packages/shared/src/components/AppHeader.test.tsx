// ABOUTME: Tests for AppHeader — network badge (shown on test networks, hidden on mainnet) and the logo link.
// ABOUTME: The badge exists to flag non-production deployments; mainnet users don't need it.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AppHeader } from './AppHeader'

describe('AppHeader network badge', () => {
  it('flags a test network', () => {
    render(<AppHeader appName="Committer" network="sepolia" />)
    expect(screen.getByText('sepolia')).toBeTruthy()
  })

  it('flags a local network', () => {
    render(<AppHeader appName="Committer" network="local" />)
    expect(screen.getByText('local')).toBeTruthy()
  })

  it('shows no badge on mainnet', () => {
    render(<AppHeader appName="Committer" network="mainnet" />)
    expect(screen.queryByText('mainnet')).toBeNull()
  })
})

describe('AppHeader logo link', () => {
  it('links the logo to logoHref in a new tab', () => {
    render(<AppHeader appName="Committer" network="mainnet" logoHref="https://example.test" />)
    const logo = screen.getByRole('link', { name: 'Armada project site' })
    expect(logo.getAttribute('href')).toBe('https://example.test')
    expect(logo.getAttribute('target')).toBe('_blank')
    expect(logo.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders a plain logo without logoHref', () => {
    render(<AppHeader appName="Committer" network="mainnet" />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})

// ABOUTME: Tests for AppHeader's network badge — shown on test networks, hidden on mainnet.
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

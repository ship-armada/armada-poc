// ABOUTME: Tests for the /invite landing page footer — "Not ready to participate yet?" nav + social links.
// ABOUTME: Uses the malformed-link branch so the on-chain pre-check (deployment/provider) never runs.

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { InviteLandingPage } from './InviteLandingPage'

describe('InviteLandingPage footer', () => {
  it('shows the "not ready" nav + social links on a malformed invite link', () => {
    render(
      <MemoryRouter initialEntries={['/invite']}>
        <InviteLandingPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Not ready to participate yet?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'The project' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Crowdfund' })).toBeTruthy()

    const discord = screen.getByRole('link', { name: 'Armada on Discord' })
    // Placeholder until the real Armada Discord invite link exists.
    expect(discord).toHaveAttribute('href', 'https://discord.gg')
    expect(discord).toHaveAttribute('target', '_blank')

    const x = screen.getByRole('link', { name: 'Armada on X' })
    expect(x).toHaveAttribute('href', 'https://x.com/ship_armada')
    expect(x).toHaveAttribute('target', '_blank')
  })
})

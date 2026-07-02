// ABOUTME: Tests for the /invite landing page footer — "Not ready to participate yet?" nav + social links.
// ABOUTME: Uses the malformed-link branch so the on-chain pre-check (deployment/provider) never runs.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { InviteLandingPage } from './InviteLandingPage'

// A valid-format invite link reaches the on-chain pre-check, which awaits
// loadDeployment() first — rejecting it short-circuits the pre-check silently
// (it's caught) so no network I/O runs in the test. The URL-scrub effect is
// independent of the pre-check, so it still fires.
vi.mock('@/config/deployments', () => ({
  loadDeployment: () => Promise.reject(new Error('no network in test')),
}))

// Surfaces the current router location's query string so a test can assert the
// signed invite params were scrubbed out of the URL.
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-search">{location.search}</div>
}

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
    expect(discord).toHaveAttribute('href', 'https://discord.gg/QcpeNenwhj')
    expect(discord).toHaveAttribute('target', '_blank')

    const x = screen.getByRole('link', { name: 'Armada on X' })
    expect(x).toHaveAttribute('href', 'https://x.com/ship_armada')
    expect(x).toHaveAttribute('target', '_blank')
  })
})

describe('InviteLandingPage URL scrub', () => {
  it('strips the signed invite params from the URL after capturing them', async () => {
    // Valid-format link: EIP-55 checksummed inviter + canonical 65-byte sig.
    const inviter = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    const sig = '0x' + '1'.repeat(130)
    const link = `/invite?inviter=${inviter}&fromHop=0&nonce=1&deadline=9999999999&sig=${sig}`

    render(
      <MemoryRouter initialEntries={[link]}>
        <InviteLandingPage />
        <LocationProbe />
      </MemoryRouter>,
    )

    // The bearer signature must not linger in the address bar / history entry.
    await waitFor(() =>
      expect(screen.getByTestId('location-search').textContent).toBe(''),
    )
  })
})

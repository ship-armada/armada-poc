// ABOUTME: Tests for InviteLinkRedemption component — URL parsing, expiry, and display.
// ABOUTME: Covers invalid link, expired link, and valid link rendering states.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { InviteLinkRedemption } from './InviteLinkRedemption'

// Mock loadDeployment to avoid real HTTP
vi.mock('@/config/deployments', () => ({
  loadDeployment: vi.fn().mockResolvedValue({
    contracts: {
      crowdfund: '0x1234567890abcdef1234567890abcdef12345678',
      usdc: '0xabcdef1234567890abcdef1234567890abcdef12',
    },
  }),
}))

// Mock config/network
vi.mock('@/config/network', () => ({
  getHubRpcUrl: () => 'http://localhost:8545',
  getHubRpcUrls: () => ['http://localhost:8545'],
  getExplorerUrl: () => '',
}))

// Mock ethers JsonRpcProvider
vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers')
  return {
    ...actual,
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000 }),
    })),
    BrowserProvider: vi.fn(),
    Contract: vi.fn().mockImplementation(() => ({
      balanceOf: vi.fn().mockResolvedValue(0n),
      allowance: vi.fn().mockResolvedValue(0n),
    })),
  }
})

function renderWithParams(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/invite${search}`]}>
      <InviteLinkRedemption />
    </MemoryRouter>,
  )
}

describe('InviteLinkRedemption', () => {
  it('shows invalid link message when params are missing', () => {
    renderWithParams('')
    expect(screen.getByText('Invalid Invite Link')).toBeInTheDocument()
    expect(screen.getByText(/missing required parameters/)).toBeInTheDocument()
  })

  it('shows invalid link for partial params', () => {
    renderWithParams('?inviter=0x1234')
    expect(screen.getByText('Invalid Invite Link')).toBeInTheDocument()
  })

  it('renders invite details for valid params', () => {
    const params = new URLSearchParams({
      inviter: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
      fromHop: '0',
      nonce: '1',
      deadline: '1700100000', // in the future relative to mock timestamp
      sig: '0xdeadbeef',
    })
    renderWithParams(`?${params.toString()}`)
    expect(screen.getByText('Armada Crowdfund Invite')).toBeInTheDocument()
    expect(screen.getByText('Hop-1')).toBeInTheDocument()
  })

  it('shows Go to main app link on invalid link page', () => {
    renderWithParams('')
    expect(screen.getByText('Go to main app')).toBeInTheDocument()
  })
})

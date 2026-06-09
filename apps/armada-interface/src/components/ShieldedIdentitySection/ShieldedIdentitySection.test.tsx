// ABOUTME: Tests for ShieldedIdentitySection — three render branches: unlocked → address + checksum, locked + EVM connected → sign-in CTA, no shielded wallet → null.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const hoisted = vi.hoisted(() => ({
  mockState: null as {
    id: string
    status: 'locked' | 'unlocked'
    railgunAddress?: string
    checksum?: string
  } | null,
}))

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({ state: hoisted.mockState }),
}))

import { ShieldedIdentitySection } from './ShieldedIdentitySection'

beforeEach(() => {
  hoisted.mockState = null
})

describe('<ShieldedIdentitySection>', () => {
  it('renders nothing when no shielded wallet record exists', () => {
    hoisted.mockState = null
    const { container } = render(<ShieldedIdentitySection />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the address + checksum when unlocked', () => {
    hoisted.mockState = {
      id: 'rg-1',
      status: 'unlocked',
      railgunAddress: '0zk1qexampleexampleexampleexampleexample1234',
      checksum: 'a3f2 91c8 b7e0',
    }
    render(<ShieldedIdentitySection />)
    expect(screen.getByText('Shielded identity')).toBeInTheDocument()
    expect(screen.getByLabelText('Anti-phishing checksum')).toHaveTextContent('a3f2 91c8 b7e0')
    // The address gets truncated to e.g. "0zk1qex…1234"; we don't assert the exact form because
    // truncateAddressEnds is a separate concern — just verify a copy button is present.
    expect(screen.getByRole('button', { name: /Copy shielded address/i })).toBeInTheDocument()
  })

  it('copies the full railgun address to the clipboard on click', async () => {
    hoisted.mockState = {
      id: 'rg-1',
      status: 'unlocked',
      railgunAddress: '0zk1full-address-here',
      checksum: 'a3f2 91c8 b7e0',
    }
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ShieldedIdentitySection />)
    fireEvent.click(screen.getByRole('button', { name: /Copy shielded address/i }))
    expect(writeText).toHaveBeenCalledWith('0zk1full-address-here')
  })

  it('renders the sign-in CTA when locked + onRequestSignIn supplied', () => {
    hoisted.mockState = {
      id: 'rg-1',
      status: 'locked',
    }
    const onRequestSignIn = vi.fn()
    render(<ShieldedIdentitySection onRequestSignIn={onRequestSignIn} />)
    expect(screen.getByText('Shielded identity')).toBeInTheDocument()
    const cta = screen.getByRole('button', { name: 'Sign in to access' })
    fireEvent.click(cta)
    expect(onRequestSignIn).toHaveBeenCalledTimes(1)
  })

  it('renders a passive "Locked" indicator when locked + no onRequestSignIn supplied', () => {
    hoisted.mockState = {
      id: 'rg-1',
      status: 'locked',
    }
    render(<ShieldedIdentitySection />)
    expect(screen.getByText('Locked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to access' })).not.toBeInTheDocument()
  })

  it('treats an unlocked-but-missing-railgunAddress state as locked (defensive)', () => {
    hoisted.mockState = {
      id: 'rg-1',
      status: 'unlocked',
      // intentionally no railgunAddress — should not crash on the copy button
    }
    render(<ShieldedIdentitySection />)
    expect(screen.queryByRole('button', { name: /Copy shielded address/i })).not.toBeInTheDocument()
  })
})

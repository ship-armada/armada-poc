// ABOUTME: Tests for ActionGrid — renders three actions (Pay / Earn / Withdraw) and dispatches the right ModalKind on each click.
// ABOUTME: Seeds a Jotai store so we can read openModalAtom after a click. useYieldRate mocked to avoid wagmi.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ActionGrid } from './ActionGrid'
import { openModalAtom } from '@/state/ui'

const openConnectModal = vi.fn()

let isConnected = true

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal }),
}))

// useYieldRate hits wagmi internals to read the vault rate; stub with a fixed rate so the
// Earn footer renders deterministically. useBalances reads atoms only — safe to leave real.
vi.mock('@/hooks/useYieldRate', () => ({
  useYieldRate: () => ({
    rate: { rate: 1_000_000n, apyBps: 0n, fetchedAt: 0 },
    isLoading: false,
    refresh: vi.fn(),
  }),
}))

function setup() {
  const store = createStore()
  render(
    <Provider store={store}>
      <ActionGrid />
    </Provider>,
  )
  return store
}

describe('<ActionGrid>', () => {
  beforeEach(() => {
    isConnected = true
    openConnectModal.mockClear()
  })

  it('renders the three action labels (Pay / Earn / Withdraw)', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Pay' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Earn' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
    // Deposit is no longer in the grid — it's the primary CTA inside BalanceHero.
    expect(screen.queryByRole('button', { name: 'Deposit' })).toBeNull()
  })

  it('opens the payment modal on Pay click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }))
    expect(store.get(openModalAtom)).toBe('payment')
    expect(openConnectModal).not.toHaveBeenCalled()
  })

  it('opens the yield-deposit modal on Earn click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Earn' }))
    expect(store.get(openModalAtom)).toBe('yield-deposit')
  })

  it('opens the unshield modal on Withdraw click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    expect(store.get(openModalAtom)).toBe('unshield')
  })

  it('renders the Earn footer with the "Earning in vault" label', () => {
    setup()
    expect(screen.getByText('Earning in vault')).toBeInTheDocument()
  })

  it('opens wallet connect instead of a modal when disconnected', () => {
    isConnected = false
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }))
    expect(openConnectModal).toHaveBeenCalled()
    expect(store.get(openModalAtom)).toBeNull()
  })
})

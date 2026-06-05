// ABOUTME: Tests for ActionGrid — renders four actions and dispatches the right ModalKind on each click.
// ABOUTME: Seeds a Jotai store so we can read openModalAtom after a click.

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

  it('renders all four action labels', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Earn' })).toBeInTheDocument()
  })

  it('opens the shield modal on Deposit click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }))
    expect(store.get(openModalAtom)).toBe('shield')
    expect(openConnectModal).not.toHaveBeenCalled()
  })

  it('opens the unshield modal on Withdraw click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    expect(store.get(openModalAtom)).toBe('unshield')
  })

  it('opens the payment modal on Send click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(store.get(openModalAtom)).toBe('payment')
  })

  it('opens the yield-deposit modal on Earn click when connected', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Earn' }))
    expect(store.get(openModalAtom)).toBe('yield-deposit')
  })

  it('opens wallet connect instead of a modal when disconnected', () => {
    isConnected = false
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }))
    expect(openConnectModal).toHaveBeenCalled()
    expect(store.get(openModalAtom)).toBeNull()
  })
})

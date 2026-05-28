// ABOUTME: Tests for EarnModal orchestrator — opens on both yield-deposit and yield-withdraw kinds, tab defaults from entry kind, switching tabs clears amount.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { EarnModal } from './EarnModal'
import { openModalAtom } from '@/state/ui'
import { shieldedUsdcAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  broadcasterRailgunAddress: '',
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0' },
}

function renderModal(opts?: { open?: 'yield-deposit' | 'yield-withdraw' | false; shielded?: bigint }) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, opts.open)
  if (opts?.shielded !== undefined) store.set(shieldedUsdcAtom, opts.shielded)
  store.set(feeQuoteAtom, FAKE_QUOTE)
  render(withTestQueryClient(
    <Provider store={store}>
      <EarnModal />
    </Provider>,
  ))
  return store
}

describe('<EarnModal>', () => {
  it('renders nothing when modal is closed', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("opens with Add funds selected when entry is 'yield-deposit'", () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    expect(screen.getByRole('tab', { name: 'Add funds' })).toHaveAttribute('aria-selected', 'true')
  })

  it("opens with Withdraw selected when entry is 'yield-withdraw'", () => {
    renderModal({ open: 'yield-withdraw', shielded: 10_000_000n })
    expect(screen.getByRole('tab', { name: 'Withdraw' })).toHaveAttribute('aria-selected', 'true')
  })

  it('renders the dialog with title "Earn"', () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Earn' })).toBeInTheDocument()
  })

  it('switching tabs clears the amount field', () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('How much to add?'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Withdraw' }))
    expect(screen.getByLabelText('How much to withdraw?')).toHaveValue('')
  })

  it('advances to review on Continue with a valid amount (add tab)', () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('How much to add?'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText('Review deposit')).toBeInTheDocument()
  })

  it('Confirm submits the tx and advances to the progress step', async () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('How much to add?'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm deposit/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })
})

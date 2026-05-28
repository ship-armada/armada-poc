// ABOUTME: Tests for ShieldModal orchestrator — open/closed gating, step advancement (input → review → progress), close resets state.
// ABOUTME: Seeds openModalAtom + usdcBalancesAtom so the user can enter an amount and proceed.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ShieldModal } from './ShieldModal'
import { openModalAtom } from '@/state/ui'
import { usdcBalancesAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  broadcasterRailgunAddress: '',
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0' },
}

function renderModal(opts?: { open?: boolean; max?: bigint }) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, 'shield')
  if (opts?.max !== undefined) {
    store.set(usdcBalancesAtom, { 31337: opts.max })
  }
  store.set(feeQuoteAtom, FAKE_QUOTE)
  render(withTestQueryClient(
    <Provider store={store}>
      <ShieldModal />
    </Provider>,
  ))
  return store
}

describe('<ShieldModal>', () => {
  it('renders nothing when openModal !== shield', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the input step when open', () => {
    renderModal({ open: true, max: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Deposit' })).toBeInTheDocument()
    expect(screen.getByLabelText('How much USDC?')).toBeInTheDocument()
  })

  it('advances to the review step after entering a valid amount', () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText('Review your deposit')).toBeInTheDocument()
    // 5.00 appears in both the hero numeral and the FeeSummary net-amount row.
    expect(screen.getAllByText('5.00').length).toBeGreaterThanOrEqual(1)
  })

  it('Back from review returns to the input step', () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(screen.getByLabelText('How much USDC?')).toBeInTheDocument()
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })

  it('Confirm submits the tx and advances to the progress step', async () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm deposit/ }))
    })
    // ProgressStep renders the TxLifecycleStepper which surfaces the StatusChip; the initial
    // executionState is 'pending' which maps to the "Pending" chip. submit() awaits IDB
    // persistence so waitFor() handles the brief gap before the record reaches the atom.
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })
})

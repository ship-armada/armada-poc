// ABOUTME: Tests for SendModal orchestrator — open/closed gating, tab switching clears recipient, kind selection visible in review, progress advance.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { SendModal } from './SendModal'
import { openModalAtom } from '@/state/ui'
import { shieldedUsdcAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

// useDisplayFees + useGasBalanceWarning hit wagmi hooks that require a WagmiProvider; these
// tests don't mount one. Stub with neutral defaults so the modal renders.
vi.mock('@/hooks/useDisplayFees', () => ({
  useDisplayFees: () => ({
    fees: {
      protocolFee: 0n,
      gasFee: 0n,
      nativeGas: null,
      totalFee: 0n,
      feeInclusive: false,
    },
    isLoading: false,
  }),
}))
vi.mock('@/hooks/useGasBalanceWarning', () => ({
  useGasBalanceWarning: () => ({
    show: false,
    nativeSymbol: 'ETH',
    formattedBalance: null,
  }),
}))

// Phase 7: tx/storage requires an unlocked keyManager (encrypted writes). UI tests don't drive
// onboarding; mock storage to no-op. Storage encryption is covered in lib/tx/storage.test.ts.
vi.mock('@/lib/tx/storage', () => ({
  putTxIfFresh: vi.fn(async () => true),
  putTx: vi.fn(async () => {}),
  deleteTx: vi.fn(async () => {}),
  loadAllTx: vi.fn(async () => []),
}))

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zk' + 'a'.repeat(40)

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  // Shape-valid 0zk for the submit-time isShieldedAddress() check on the external-tab→hub path.
  broadcasterRailgunAddress: '0zk' + 'a'.repeat(64),
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: { open?: boolean; shielded?: bigint }) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, 'payment')
  if (opts?.shielded !== undefined) store.set(shieldedUsdcAtom, opts.shielded)
  store.set(feeQuoteAtom, FAKE_QUOTE)
  render(withTestQueryClient(
    <Provider store={store}>
      <SendModal />
    </Provider>,
  ))
  return store
}

describe('<SendModal>', () => {
  it('renders nothing when openModal !== payment', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the input step with title "Send" when open', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Private/ })).toBeInTheDocument()
  })

  it('private tab: enters 0zk recipient, advances to review with "Private transfer" label', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
  })

  it('external + xchain: shows the cross-chain tag in review', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('tab', { name: /External wallet/ }))
    // DepositAmountCard's chain dropdown is a button + listbox (no native <select>), so we
    // open it and click the desired option instead of fireEvent.change.
    fireEvent.click(screen.getByRole('button', { name: /Network|Anvil|Sepolia|Base|Arbitrum/i }))
    // Anvil chain 31338 in local mode shows up as the second option ("Client A"). Use a
    // partial match because the exact label depends on config.
    const options = screen.getAllByRole('option')
    const clientOption = options.find(o => o.textContent?.match(/Client|31338/i)) ?? options[1]
    fireEvent.click(clientOption!)
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_EVM } })
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('switching tabs clears the recipient field', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    fireEvent.click(screen.getByRole('tab', { name: /External wallet/ }))
    expect(screen.getByLabelText('Recipient address')).toHaveValue('')
  })

  it('Confirm advances to the progress step', async () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })
})

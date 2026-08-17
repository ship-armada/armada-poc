// ABOUTME: Tests for SendModal orchestrator — variant (send/withdraw), address-driven kind selection, the recipient→amount→review→progress flow, and withdraw prefill.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { SendModal } from './SendModal'
import { openModalAtom } from '@/state/ui'
import {
  activeShieldedWalletIdAtom,
  evmAddressAtom,
  shieldedUsdcAtom,
  shieldedUsdcSpendableAtom,
} from '@/state/wallet'
import { feeQuoteAtom, feeQuoteFetchedAtAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

// useDisplayFees + useGasBalanceWarning hit wagmi hooks that require a WagmiProvider; these
// tests don't mount one. Stub with neutral defaults so the modal renders.
// This tab is the executor leader (single-tab test env) so useTx.submit isn't refused (P1-26).
vi.mock('@/lib/tx/executor', async (importActual) => ({
  ...await importActual<typeof import('@/lib/tx/executor')>(),
  getIsLeader: () => true,
}))

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

// The private-send submit path strict-validates the 0zk recipient via the SDK
// (validateShieldedAddressStrict → dynamic import), which crashes jsdom at load. Keep the sync
// validators real; stub only the strict async check to pass for the test's fake 0zk fixture.
vi.mock('@/lib/address', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/address')>()),
  validateShieldedAddressStrict: vi.fn(async () => true),
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
const OTHER_EVM = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const VALID_0ZK = '0zk' + 'a'.repeat(40)

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  // Shape-valid 0zk for the submit-time isShieldedAddress() broadcaster-address check.
  broadcasterShieldedAddress: '0zk' + 'a'.repeat(64),
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: {
  open?: 'payment' | 'withdraw' | false
  shielded?: bigint
  evm?: string
}) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, opts.open)
  if (opts?.shielded !== undefined) {
    store.set(shieldedUsdcAtom, opts.shielded)
    store.set(shieldedUsdcSpendableAtom, opts.shielded) // no pending in tests → spendable == total
  }
  if (opts?.evm) store.set(evmAddressAtom, opts.evm)
  // useTx.submit() refuses to write a record without an active shielded walletId (Phase 6
  // scoping invariant). Seed a placeholder so the Confirm flow doesn't trip the guard.
  store.set(activeShieldedWalletIdAtom, 'rg-test')
  store.set(feeQuoteAtom, FAKE_QUOTE)
  // staleAtom treats a quote with no fetch timestamp as stale (350e084), which would send
  // Confirm down the real refresh()/fetchFees path — unreachable in jsdom. A fresh
  // fetchedAt keeps the seeded FAKE_QUOTE inside the 4-minute freshness window.
  store.set(feeQuoteFetchedAtAtom, Date.now())
  render(withTestQueryClient(
    <Provider store={store}>
      <SendModal />
    </Provider>,
  ))
  return store
}

/** Advance the recipient step: type an address, (optionally) pick a chain, click Continue. */
function completeRecipientStep(recipient: string, chainValue?: string) {
  fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: recipient } })
  if (chainValue !== undefined) {
    fireEvent.change(screen.getByLabelText('Destination chain'), { target: { value: chainValue } })
  }
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
}

describe('<SendModal>', () => {
  it('renders nothing when no send/withdraw modal is open', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the send variant on the recipient step with the "Send" title', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByLabelText('Recipient address')).toBeInTheDocument()
  })

  it('Continue is disabled until the recipient is a valid address', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: 'not-an-address' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('a 0zk recipient hides the chain selector (private transfer)', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    expect(screen.queryByLabelText('Destination chain')).toBeNull()
  })

  it('a 0x recipient reveals the chain selector (public transfer)', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_EVM } })
    expect(screen.getByLabelText('Destination chain')).toBeInTheDocument()
  })

  it('0zk recipient → transfer-shielded: review shows "Private transfer"', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_0ZK)
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
  })

  it('0x recipient to hub → unshield-local: review shows "External wallet", no cross-chain tag', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_EVM, '31337')
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('External wallet')).toBeInTheDocument()
    expect(screen.queryByText('cross-chain')).toBeNull()
  })

  it('0x recipient to a client chain → unshield-xchain: review shows the cross-chain tag', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_EVM, '31338')
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('transfer-shielded Confirm advances to the progress step', async () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_0ZK)
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('unshield-local Confirm advances to the progress step', async () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_EVM, '31337')
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('unshield-xchain Confirm advances to the progress step', async () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_EVM, '31338')
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('Cancel on the recipient step closes the modal', () => {
    const store = renderModal({ open: 'payment', shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })

  it('Back on the amount step returns to the recipient step', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_0ZK)
    // On the amount step now — go Back.
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    // Recipient input is editable again and retains the typed value.
    expect(screen.getByLabelText('Recipient address')).toHaveValue(VALID_0ZK)
  })

  describe('withdraw variant', () => {
    it('opens with the "Withdraw" title and prefills the connected wallet', () => {
      renderModal({ open: 'withdraw', shielded: 10_000_000n, evm: VALID_EVM })
      expect(screen.getByRole('dialog', { name: 'Withdraw' })).toBeInTheDocument()
      expect(screen.getByLabelText('Recipient address')).toHaveValue(VALID_EVM)
    })

    it('the prefilled recipient is editable — can withdraw to any other 0x address', async () => {
      renderModal({ open: 'withdraw', shielded: 10_000_000n, evm: VALID_EVM })
      fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: OTHER_EVM } })
      fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
      fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '4' } })
      fireEvent.click(screen.getByRole('button', { name: /Review/ }))
      expect(screen.getByText('Review your withdrawal')).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Confirm withdrawal/ }))
      })
      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument()
      })
    })

    it('uses withdraw copy — "Review your withdrawal" and "Confirm withdrawal"', () => {
      renderModal({ open: 'withdraw', shielded: 10_000_000n, evm: VALID_EVM })
      fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
      fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '5' } })
      fireEvent.click(screen.getByRole('button', { name: /Review/ }))
      expect(screen.getByText('Review your withdrawal')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Confirm withdrawal/ })).toBeInTheDocument()
    })
  })
})

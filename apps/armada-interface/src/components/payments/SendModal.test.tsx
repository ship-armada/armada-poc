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
import { getChainById } from '@/config/network'
import { withTestQueryClient } from '@/test-utils/queryClient'

// useDisplayFees + useGasBalanceWarning hit wagmi hooks that require a WagmiProvider; these
// tests don't mount one. Stub with neutral defaults so the modal renders.
// This tab is the executor leader (single-tab test env) so useTx.submit isn't refused (P1-26).
vi.mock('@/lib/tx/executor', async (importActual) => ({
  ...await importActual<typeof import('@/lib/tx/executor')>(),
  getIsLeader: () => true,
}))

// SendModal reads the connected wallet's connector via wagmi's useAccount to brand the recipient
// row glyph; these tests don't mount a WagmiProvider, so stub it with a MetaMask connector.
vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ connector: { name: 'MetaMask' } }),
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

/** Advance the recipient step: type an address, (optionally) pick a chain via the popover, click Continue. */
function completeRecipientStep(recipient: string, chainValue?: string) {
  fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: recipient } })
  if (chainValue !== undefined) {
    // Open the styled chain popover and click the option whose label matches the chainId.
    fireEvent.click(screen.getByLabelText('Destination chain'))
    const name = getChainById(Number(chainValue))?.name ?? chainValue
    fireEvent.click(screen.getByRole('option', { name }))
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

  it('Continue enables only once the recipient is a valid address', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    // Empty + invalid: the CTA is always present but disabled + labeled "Enter address".
    expect(screen.getByRole('button', { name: /Enter address/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: 'not-an-address' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enter address/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    expect(screen.getByRole('button', { name: /^Continue$/ })).not.toBeDisabled()
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

  it('0zk recipient → transfer-shielded: review shows the "Private" privacy row + no network row', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_0ZK)
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('Private transfer.')).toBeInTheDocument()
    expect(screen.queryByText('Network')).toBeNull()
  })

  it('0x recipient to hub → unshield-local: review shows the "Public" privacy row + hub network', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_EVM, '31337')
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('Public transfer.')).toBeInTheDocument()
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
  })

  it('0x recipient to a client chain → unshield-xchain: review shows the client network name', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_EVM, '31338')
    fireEvent.change(screen.getByLabelText('Send amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText(/Anvil Client A/)).toBeInTheDocument()
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

  it('the close button closes the modal', () => {
    const store = renderModal({ open: 'payment', shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(store.get(openModalAtom)).toBeNull()
  })

  it('Back on the amount step returns to the recipient step', () => {
    renderModal({ open: 'payment', shielded: 10_000_000n })
    completeRecipientStep(VALID_0ZK)
    // On the amount step now — go Back.
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    // Recipient input retains the address (shown middle-truncated when blurred; full value in `title`).
    expect(screen.getByLabelText('Recipient address')).toHaveAttribute('title', VALID_0ZK)
  })

  describe('withdraw variant', () => {
    it('opens with the "Withdraw" title and prefills the connected wallet', () => {
      renderModal({ open: 'withdraw', shielded: 10_000_000n, evm: VALID_EVM })
      expect(screen.getByRole('dialog', { name: 'Withdraw' })).toBeInTheDocument()
      expect(screen.getByLabelText('Recipient address')).toHaveAttribute('title', VALID_EVM)
    })

    it('the prefilled recipient is editable — can withdraw to any other 0x address', async () => {
      renderModal({ open: 'withdraw', shielded: 10_000_000n, evm: VALID_EVM })
      fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: OTHER_EVM } })
      fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
      fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '4' } })
      fireEvent.click(screen.getByRole('button', { name: /Review/ }))
      expect(screen.getByText('Review your USDC unshield')).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
      })
      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument()
      })
    })

    it('uses withdraw copy — "Review your USDC unshield" and "Confirm"', () => {
      renderModal({ open: 'withdraw', shielded: 10_000_000n, evm: VALID_EVM })
      fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
      fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '5' } })
      fireEvent.click(screen.getByRole('button', { name: /Review/ }))
      expect(screen.getByText('Review your USDC unshield')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    })
  })
})

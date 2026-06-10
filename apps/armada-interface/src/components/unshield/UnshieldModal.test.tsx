// ABOUTME: Tests for UnshieldModal orchestrator — open/closed gating, step advancement, kind selection (local vs xchain) based on destination.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { UnshieldModal } from './UnshieldModal'
import { openModalAtom } from '@/state/ui'
import { activeRailgunWalletIdAtom, shieldedUsdcAtom, evmAddressAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
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

// Phase 7: tx/storage requires an unlocked keyManager (encrypted writes). UI tests don't drive
// onboarding; mock storage to no-op. Storage encryption is covered in lib/tx/storage.test.ts.
vi.mock('@/lib/tx/storage', () => ({
  putTxIfFresh: vi.fn(async () => true),
  putTx: vi.fn(async () => {}),
  deleteTx: vi.fn(async () => {}),
  loadAllTx: vi.fn(async () => []),
}))

const VALID_ADDR = '0x1234567890abcdef1234567890abcdef12345678'

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  // Shape-valid 0zk for the new isShieldedAddress() submit-time check. UnshieldModal rejects an
  // empty / malformed broadcaster address before kicking proof generation.
  broadcasterRailgunAddress: '0zk' + 'a'.repeat(64),
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: {
  open?: boolean
  shielded?: bigint
  evm?: string
}) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, 'unshield')
  if (opts?.shielded !== undefined) store.set(shieldedUsdcAtom, opts.shielded)
  if (opts?.evm) store.set(evmAddressAtom, opts.evm)
  // useTx.submit() refuses to write a record without an active shielded walletId (Phase 6
  // scoping invariant). Seed a placeholder so the Confirm flow doesn't trip the guard.
  store.set(activeRailgunWalletIdAtom, 'rg-test')
  store.set(feeQuoteAtom, FAKE_QUOTE)
  render(withTestQueryClient(
    <Provider store={store}>
      <UnshieldModal />
    </Provider>,
  ))
  return store
}

describe('<UnshieldModal>', () => {
  it('renders nothing when openModal !== unshield', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the input step with title "Withdraw" when open', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Withdraw' })).toBeInTheDocument()
    // The WithdrawRecipientField renders the locked recipient label + connected wallet address.
    expect(screen.getByLabelText('Recipient address')).toBeInTheDocument()
  })

  it('shows the connected EVM address in the recipient row', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    // Truncated: "0x1234...345678" — assert the first 6 chars appear in the recipient row.
    expect(screen.getByText(/0x1234/)).toBeInTheDocument()
  })

  it('shows an em-dash when no wallet is connected', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    // walletAddress null → "—" in the recipient row.
    expect(screen.getByLabelText('Recipient address').textContent).toContain('—')
  })

  it('advances to the review step on Review with valid inputs', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('Review your withdrawal')).toBeInTheDocument()
  })

  it('shows the xchain tag in review when destination is a client chain', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    // DepositAmountCard chain dropdown is a button + listbox (no native <select>).
    fireEvent.click(screen.getByRole('button', { name: /Network|Anvil|Sepolia|Base|Arbitrum/i }))
    const options = screen.getAllByRole('option')
    const clientOption = options.find(o => o.textContent?.match(/Client|31338/i)) ?? options[1]
    fireEvent.click(clientOption!)
    fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('Confirm advances to the progress step', async () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.change(screen.getByLabelText('Withdrawal amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm withdrawal/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })
})

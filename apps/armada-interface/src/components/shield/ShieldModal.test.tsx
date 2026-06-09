// ABOUTME: Tests for ShieldModal orchestrator — open/closed gating, step advancement (input → review → progress), close resets state.
// ABOUTME: Seeds openModalAtom + usdcBalancesAtom so the user can enter an amount and proceed.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ShieldModal } from './ShieldModal'
import { openModalAtom } from '@/state/ui'
import { activeRailgunWalletIdAtom, usdcBalancesAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

// useDisplayFees calls wagmi's useReadContract which requires a WagmiProvider; these tests
// don't mount one, so stub the hook with a deterministic DisplayFees value. The protocolFee
// arithmetic is exercised by relayer.test.ts; this mock just keeps the modal renderable.
vi.mock('@/hooks/useDisplayFees', () => ({
  useDisplayFees: () => ({
    fees: {
      protocolFee: 0n,
      gasFee: 0n,
      nativeGas: null,
      totalFee: 0n,
      feeInclusive: true,
    },
    isLoading: false,
  }),
}))

// useGasBalanceWarning calls wagmi's useAccount/useBalance — same provider requirement.
// "No warning" keeps the GasBalanceNotice hidden; gasless-mode branching is asserted in
// ShieldInputStep.test.tsx by directly setting gaslessMode (no integration concern here).
vi.mock('@/hooks/useGasBalanceWarning', () => ({
  useGasBalanceWarning: () => ({
    show: false,
    nativeSymbol: 'ETH',
    formattedBalance: null,
  }),
}))

// Phase 7: tx/storage now requires an unlocked keyManager (records are AES-256-GCM encrypted
// at rest under the active wallet's historyEncryptionKey). Modal tests don't drive the
// onboarding flow, so the keyManager is locked here. Mock storage to no-op the writes so the
// Confirm-clicks-through-to-progress assertions exercise the UI orchestration without
// tripping the "wallet locked" guard. Storage encryption itself is covered in lib/tx/storage.test.ts.
vi.mock('@/lib/tx/storage', () => ({
  putTxIfFresh: vi.fn(async () => true),
  putTx: vi.fn(async () => {}),
  deleteTx: vi.fn(async () => {}),
  loadAllTx: vi.fn(async () => []),
}))

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  broadcasterRailgunAddress: '',
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: { open?: boolean; max?: bigint }) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, 'shield')
  if (opts?.max !== undefined) {
    store.set(usdcBalancesAtom, { 31337: opts.max })
  }
  // useTx.submit() refuses to write a record without an active shielded walletId (Phase 6
  // scoping invariant — every TxRecord must be filterable by walletContext.railgunWalletId).
  // Seed a placeholder id so the Confirm flow exercises the orchestration without tripping
  // the guard. The id value isn't asserted; it just satisfies the invariant.
  store.set(activeRailgunWalletIdAtom, 'rg-test')
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
    expect(screen.getByLabelText('Deposit amount')).toBeInTheDocument()
  })

  it('advances to the review step after entering a valid amount', () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Deposit amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText('Review your deposit')).toBeInTheDocument()
    // 5.00 appears in both the hero numeral and the FeeSummary net-amount row.
    expect(screen.getAllByText('5.00').length).toBeGreaterThanOrEqual(1)
  })

  it('Back from review returns to the input step', () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Deposit amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(screen.getByLabelText('Deposit amount')).toBeInTheDocument()
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })

  it('Confirm submits the tx and advances to the progress step', async () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Deposit amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
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

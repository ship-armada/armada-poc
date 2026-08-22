// ABOUTME: Tests for EarnModal orchestrator — opens on both yield-deposit and yield-withdraw kinds, tab defaults from entry kind, switching tabs clears amount.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { EarnModal } from './EarnModal'
import { openModalAtom } from '@/state/ui'
import { activeShieldedWalletIdAtom, shieldedUsdcAtom, shieldedUsdcSpendableAtom } from '@/state/wallet'
import { feeQuoteAtom, feeQuoteFetchedAtAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

// useDisplayFees + useGasBalanceWarning hit wagmi hooks that require a WagmiProvider; these
// tests don't mount one. Stub with neutral defaults.
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

// Submit always refetches a fresh quote (fee-refresh fix). Mock useFees so refresh() resolves the
// fake quote deterministically (the real refresh() hits fetchFees → network, unreachable in jsdom).
const hoistedFees = vi.hoisted(() => ({
  quote: {
    cacheId: 'test-cache',
    expiresAt: 0,
    chainId: 31337,
    broadcasterShieldedAddress: '0zk' + 'a'.repeat(64),
    fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
  },
}))
vi.mock('@/hooks/useFees', () => ({
  useFees: () => ({
    quote: hoistedFees.quote,
    isStale: false,
    isUnavailable: false,
    refresh: vi.fn(async () => hoistedFees.quote),
  }),
  FEES_QUERY_KEY: ['fees'],
}))

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  broadcasterShieldedAddress: '0zk' + 'a'.repeat(64),
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: { open?: 'yield-deposit' | 'yield-withdraw' | false; shielded?: bigint }) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, opts.open)
  if (opts?.shielded !== undefined) {
    store.set(shieldedUsdcAtom, opts.shielded)
    store.set(shieldedUsdcSpendableAtom, opts.shielded) // no pending in tests → spendable == total
  }
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

  it("opens with Add to vault selected when entry is 'yield-deposit'", () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    expect(screen.getByRole('tab', { name: 'Add to vault' })).toHaveAttribute('aria-selected', 'true')
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
    fireEvent.change(screen.getByLabelText('Shielded vault deposit amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Withdraw' }))
    expect(screen.getByLabelText('Shielded vault withdrawal amount')).toHaveValue('')
  })

  it('advances to review on Continue with a valid amount (add tab)', () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shielded vault deposit amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByRole('heading', { name: 'Review USDC shielded transfer to the vault' })).toBeInTheDocument()
  })

  it('Confirm submits the tx and advances to the progress step', async () => {
    renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shielded vault deposit amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm deposit/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Preparing transaction')).toBeInTheDocument()
    })
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: 'yield-deposit', shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })
})

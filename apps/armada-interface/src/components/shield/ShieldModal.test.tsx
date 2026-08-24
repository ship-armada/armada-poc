// ABOUTME: Tests for ShieldModal orchestrator — open/closed gating, step advancement (input → review → progress), close resets state.
// ABOUTME: Seeds openModalAtom + usdcBalancesAtom so the user can enter an amount and proceed.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ShieldModal } from './ShieldModal'
import { openModalAtom } from '@/state/ui'
import {
  activeShieldedWalletIdAtom,
  evmAddressAtom,
  shieldedUsdcAtom,
  shieldedUsdcSpendableAtom,
  usdcBalancesAtom,
} from '@/state/wallet'
import { feeQuoteAtom, feeQuoteFetchedAtAtom } from '@/state/fees'
import { txListAtom } from '@/state/tx'
import { withTestQueryClient } from '@/test-utils/queryClient'
import type { TxRecord } from '@/lib/tx/types'

/** A POLL_TIMEOUT'd shield of `amount` (6dp) for the active test wallet — may still be on-chain. */
function unresolvedShield(amount: bigint): TxRecord {
  return {
    id: 'prior-shield',
    kind: 'shield',
    executionState: 'failed',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 3,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount, feeCacheId: '', fromChainId: 31337 },
    artifacts: { sourceTxHash: '0xfeed', error: { code: 'POLL_TIMEOUT', message: 't', txHash: '0xfeed' } },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rg-test', sourceChainId: 31337 },
  } as TxRecord
}

// useDisplayFees calls wagmi's useReadContract which requires a WagmiProvider; these tests
// don't mount one, so stub the hook with a deterministic DisplayFees value. The protocolFee
// arithmetic is exercised by relayer.test.ts; this mock just keeps the modal renderable.
// This tab is the executor leader (single-tab test env) so useTx.submit isn't refused (P1-26).
vi.mock('@/lib/tx/executor', async (importActual) => ({
  ...await importActual<typeof import('@/lib/tx/executor')>(),
  getIsLeader: () => true,
  // No-op the executor so a submitted record deterministically sits at build-proof (the wallet
  // step). With the real executor the shield handler can't complete in the test env and the record
  // races to `failed`, flipping the step off `wallet` before the assertions can catch it. These
  // tests exercise the submit → wallet-step UI orchestration, not real executor progression.
  executeTx: () => {},
}))

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

// useFees hits the relayer's /fees endpoint (React Query); there's no backend in the test env, so
// the real hook's `refresh()` resolves to null. Since #506, `submit()` calls `resolveFreshQuote`
// (which awaits `refresh()`) before advancing, and throws → 'error' step when the quote is null —
// so the wallet-step assertions can't be reached without a deterministic quote. Stub a zero-fee
// hub quote (matches the mocked useDisplayFees) + a `refresh` that resolves to it, keeping the
// submit path hermetic and order-independent. (Live fee fetching is covered in useFees.test.ts.)
const STUB_FEE_QUOTE = {
  cacheId: 'test-cache-id',
  expiresAt: Number.MAX_SAFE_INTEGER,
  chainId: 31337,
  broadcasterShieldedAddress: '0zk' + '0'.repeat(60),
  fees: {
    transfer: '0',
    unshield: '0',
    crossContract: '0',
    crossChainShield: '0',
    crossChainUnshield: '0',
    shield: '0',
    shieldXchain: '0',
  },
}
vi.mock('@/hooks/useFees', () => ({
  useFees: () => ({
    quote: STUB_FEE_QUOTE,
    isStale: false,
    isUnavailable: false,
    refresh: async () => STUB_FEE_QUOTE,
  }),
}))

// ShieldModal reads the connected EVM address via wagmi's useAccount for the review-step summary;
// these tests don't mount a WagmiProvider, so stub it with a fixed address.
vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: '0xabc' }),
}))

// useGasBalanceWarning calls wagmi's useAccount/useBalance — same provider requirement.
// "No warning" keeps the GasBalanceNotice hidden; the amount-step gating is covered in ShieldAmountStep.test.tsx.
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
  broadcasterShieldedAddress: '',
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: {
  open?: boolean
  kind?: 'shield' | 'unshield'
  max?: bigint
  spendable?: bigint
  evm?: string
}) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, opts.kind ?? 'shield')
  if (opts?.max !== undefined) {
    store.set(usdcBalancesAtom, { 31337: opts.max })
  }
  if (opts?.spendable !== undefined) {
    store.set(shieldedUsdcSpendableAtom, opts.spendable)
    store.set(shieldedUsdcAtom, opts.spendable) // no pending in tests → spendable == total
  }
  if (opts?.evm) store.set(evmAddressAtom, opts.evm)
  // useTx.submit() refuses to write a record without an active shielded walletId (Phase 6
  // scoping invariant — every TxRecord must be filterable by walletContext.shieldedWalletId).
  // Seed a placeholder id so the Confirm flow exercises the orchestration without tripping
  // the guard. The id value isn't asserted; it just satisfies the invariant.
  store.set(activeShieldedWalletIdAtom, 'rg-test')
  store.set(feeQuoteAtom, FAKE_QUOTE)
  // staleAtom treats a quote with no fetch timestamp as stale (350e084), which would send
  // Confirm down the real refresh()/fetchFees path — unreachable in jsdom. A fresh
  // fetchedAt keeps the seeded FAKE_QUOTE inside the 4-minute freshness window.
  store.set(feeQuoteFetchedAtAtom, Date.now())
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
    expect(screen.getByRole('dialog', { name: 'Shield' })).toBeInTheDocument()
    expect(screen.getByLabelText('Shield amount')).toBeInTheDocument()
  })

  it('advances to the review step after entering a valid amount', () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByRole('heading', { name: 'Review your USDC shield' })).toBeInTheDocument()
    // Amount renders full-precision ("5") in the big amount block and 2dp in the summary total
    // ("5.00 USDC"); match the summary total.
    expect(screen.getAllByText(/5\.00/).length).toBeGreaterThanOrEqual(1)
  })

  it('Back from review returns to the input step', () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(screen.getByLabelText('Shield amount')).toBeInTheDocument()
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })

  it('Confirm submits the tx and advances to the dedicated wallet step', async () => {
    renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Confirm$/ }))
    })
    // Confirm now lands on the wallet step (approve/sign checklist). The record is at build-proof
    // (no prompt live yet), so the title reads "Preparing your deposit…". submit() awaits IDB
    // persistence, so waitFor() covers the brief gap before the record reaches the atom.
    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'Wallet confirmations' })).toBeInTheDocument()
    })
    expect(screen.getByText('Preparing your shield…')).toBeInTheDocument()
  })

  it('does not create a second record when Confirm is double-clicked (P0-7)', async () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    const confirm = screen.getByRole('button', { name: /^Confirm$/ })
    // Fire twice before React can flush the disabled state — the synchronous submittingRef guard
    // must make the second click a no-op. Without it, a fast double-click = two real deposits.
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })
    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'Wallet confirmations' })).toBeInTheDocument()
    })
    expect(store.get(txListAtom).length).toBe(1)
  })

  it('warns at review when an unresolved same-amount deposit may still be on-chain (S-L7)', () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    store.set(txListAtom, [unresolvedShield(5_000_000n)])
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByText(/may still be processing on chain/i)).toBeInTheDocument()
  })

  it('does not warn when the unresolved deposit is a different amount (S-L7)', () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    store.set(txListAtom, [unresolvedShield(5_000_000n)])
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.queryByText(/may still be processing/i)).toBeNull()
  })

  it('in-flight tx is dismissible — closing backgrounds the tx without cancelling it (S-M2)', async () => {
    const store = renderModal({ open: true, max: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Confirm$/ }))
    })
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Wallet confirmations' })).toBeInTheDocument(),
    )

    // The Close affordance is present during the wallet/progress steps (was hidden pre-S-M2).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })

    // Modal closed, but the record was NOT cancelled/dismissed — it keeps running in the
    // background (and would surface in the dashboard InProgressCard).
    expect(store.get(openModalAtom)).toBeNull()
    const rec = store.get(txListAtom).find(t => t.kind === 'shield')
    expect(rec).toBeDefined()
    expect(['cancelled', 'dismissed']).not.toContain(rec!.executionState)
  })
})

describe('<ShieldModal> — Shield/Unshield tabs', () => {
  const EVM = '0x1234567890abcdef1234567890abcdef12345678'

  it('opens on the Unshield tab from openModal=unshield', () => {
    renderModal({ open: true, kind: 'unshield', spendable: 10_000_000n, evm: EVM })
    expect(screen.getByRole('dialog', { name: 'Unshield' })).toBeInTheDocument()
    expect(screen.getByText('Unshield your USDC')).toBeInTheDocument()
    expect(screen.getByLabelText('Unshield amount')).toBeInTheDocument()
  })

  it('opens on the Shield tab from openModal=shield with both tabs present', () => {
    renderModal({ open: true, kind: 'shield', max: 10_000_000n, spendable: 10_000_000n, evm: EVM })
    expect(screen.getByText('Shield your USDC')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Shield' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Unshield' })).toBeInTheDocument()
  })

  it('carries the typed amount across the Shield → Unshield toggle', () => {
    renderModal({ open: true, kind: 'shield', max: 10_000_000n, spendable: 10_000_000n, evm: EVM })
    fireEvent.change(screen.getByLabelText('Shield amount'), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Unshield' }))
    expect(screen.getByLabelText('Unshield amount')).toHaveValue('7')
  })
})

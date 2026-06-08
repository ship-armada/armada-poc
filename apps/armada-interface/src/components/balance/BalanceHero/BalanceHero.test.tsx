// ABOUTME: Tests for BalanceHero — total private USDC, "available" sub-caption, syncing placeholder, gradient Deposit CTA.
// ABOUTME: Renders with Jotai's Provider + seeds atoms; mocks useOpenActionModal + useYieldRate to avoid wagmi providers.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { BalanceHero } from './BalanceHero'
import { shieldedUsdcAtom, syncStateAtom, yieldSharesAtom } from '@/state/wallet'
import { txListAtom } from '@/state/tx'
import type { TxRecord } from '@/lib/tx/types'
import { withTestQueryClient } from '@/test-utils/queryClient'

// useYieldRate hits wagmi to read the vault rate; stub with a fixed 1:1 USDC-per-share rate
// so sharesToUsdc returns yieldShares unchanged (easy assertion math).
vi.mock('@/hooks/useYieldRate', () => ({
  useYieldRate: () => ({
    rate: { rate: 1_000_000_000_000_000_000n, apyBps: 0n, fetchedAt: 0 },
    isLoading: false,
    refresh: vi.fn(),
  }),
}))

// useOpenActionModal reads wagmi/useAccount + rainbowkit/useConnectModal. Mock it to a plain
// setter so the Deposit click test can assert the modal-open atom directly.
const openActionModal = vi.fn()
vi.mock('@/hooks/useOpenActionModal', () => ({
  useOpenActionModal: () => openActionModal,
}))

function completedDeposit(amount: bigint): TxRecord {
  return {
    id: 'dep-1',
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: ['hub-confirmed'],
    meta: { amount, feeCacheId: 'f', fromChainId: 1 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rg', sourceChainId: 1 },
    createdAt: 0,
    updatedAt: 0,
    updatedSeq: 1,
  } as TxRecord
}

function renderWith(values: {
  shielded: bigint | null
  yieldShares: bigint | null
  txs?: ReadonlyArray<TxRecord>
  sync?: { status: 'idle' | 'syncing'; progress: number }
}) {
  const store = createStore()
  store.set(shieldedUsdcAtom, values.shielded)
  store.set(yieldSharesAtom, values.yieldShares)
  if (values.txs) store.set(txListAtom, [...values.txs])
  if (values.sync) store.set(syncStateAtom, values.sync)
  return render(withTestQueryClient(
    <Provider store={store}>
      <BalanceHero />
    </Provider>,
  ))
}

describe('<BalanceHero>', () => {
  it('renders the "Total USDC Private Balance" label and Deposit CTA', () => {
    renderWith({ shielded: 10_000_000_000n, yieldShares: 0n })
    expect(screen.getByText('Total USDC Private Balance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeInTheDocument()
  })

  it('shows the in-card sync block when shielded sync is mid-flight', () => {
    renderWith({
      shielded: null,
      yieldShares: 0n,
      sync: { status: 'syncing', progress: 0.25 },
    })
    expect(screen.getByText('Loading your private balance')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    // Deposit CTA is suppressed during sync — the balance isn't trustworthy yet.
    expect(screen.queryByRole('button', { name: 'Deposit' })).toBeNull()
  })

  it('total = shielded + earningUsdc; available = shielded only', () => {
    // 10,000 shielded + 5,000 vault (shares × 1:1 rate) = 15,000 total. Available = 10,000.
    renderWith({ shielded: 10_000_000_000n, yieldShares: 5_000_000_000n })
    expect(screen.getByText('15,000.00')).toBeInTheDocument()
    expect(screen.getByText('10,000.00 available')).toBeInTheDocument()
  })

  it('falls back to tx-history total when chain sync has not written shieldedUsdcAtom yet', () => {
    renderWith({
      shielded: null,
      yieldShares: 0n,
      txs: [completedDeposit(1_000_000_000n)],
    })
    expect(screen.queryByText('Syncing…')).not.toBeInTheDocument()
    // Total + available both show 1,000.00 since no vault contribution.
    expect(screen.getAllByText('1,000.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('1,000.00 available')).toBeInTheDocument()
  })

  it('renders total even when yieldShares is still null (yield sync is independent)', () => {
    renderWith({ shielded: 1_000_000n, yieldShares: null })
    expect(screen.queryByText('Syncing…')).not.toBeInTheDocument()
    expect(screen.getByText('1.00 available')).toBeInTheDocument()
  })

  it('Deposit click invokes openActionModal("shield")', () => {
    openActionModal.mockClear()
    renderWith({ shielded: 10_000_000n, yieldShares: 0n })
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }))
    expect(openActionModal).toHaveBeenCalledWith('shield')
  })
})

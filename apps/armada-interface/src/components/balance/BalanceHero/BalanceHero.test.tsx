// ABOUTME: Tests for BalanceHero — verifies syncing placeholder, formatted total, breakdown values across nullable states.
// ABOUTME: Renders with Jotai's Provider and seeds atoms so the test doesn't depend on app boot order.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { BalanceHero } from './BalanceHero'
import { shieldedUsdcAtom, syncStateAtom, yieldSharesAtom } from '@/state/wallet'
import { txListAtom } from '@/state/tx'
import type { TxRecord } from '@/lib/tx/types'
import { withTestQueryClient } from '@/test-utils/queryClient'

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
  it('shows the syncing placeholder only when chain and activity history are both empty', () => {
    renderWith({
      shielded: null,
      yieldShares: 0n,
      sync: { status: 'syncing', progress: 0 },
    })
    expect(screen.getByText('Syncing private balance…')).toBeInTheDocument()
  })

  it('shows the deposit total from activity when Railgun sync has not written the atom yet', () => {
    renderWith({
      shielded: null,
      yieldShares: 0n,
      txs: [completedDeposit(1_000_000_000n)],
    })
    expect(screen.queryByText('Syncing private balance…')).not.toBeInTheDocument()
    expect(screen.getAllByText('1,000.00').length).toBeGreaterThanOrEqual(1)
  })

  it('renders the shielded total even when yieldShares is still null (yield sync is independent)', () => {
    renderWith({ shielded: 1_000_000n, yieldShares: null })
    expect(screen.queryByText('Syncing private balance…')).not.toBeInTheDocument()
    // "1.00" appears twice: once in the total, once in the breakdown row.
    expect(screen.getAllByText('1.00').length).toBeGreaterThanOrEqual(1)
  })

  it('renders an em-dash for the earning sub-balance when yieldRate is null (stub returns null today)', () => {
    renderWith({ shielded: 10_200_120_000n, yieldShares: 0n })
    // "10,200.12" appears in the total AND in the breakdown row (since earningUsdc = 0 contribution).
    expect(screen.getAllByText('10,200.12').length).toBeGreaterThanOrEqual(1)
    // yieldShares is 0 but yieldRate is null (stub), so earningUsdc is null → breakdown shows "—"
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('renders the static "Total private USDC" label and "USDC" unit suffix when synced (total displays)', () => {
    renderWith({ shielded: 10_200_120_000n, yieldShares: 0n })
    expect(screen.getByText(/Total private USDC/i)).toBeInTheDocument()
    // Total renders the shielded amount (earningUsdc is null but treated as 0 in the total).
    expect(screen.getByText('USDC')).toBeInTheDocument()
  })

  it('renders both breakdown labels', () => {
    renderWith({ shielded: 10_200_120_000n, yieldShares: 0n })
    expect(screen.getByText('Available privately')).toBeInTheDocument()
    expect(screen.getByText('Earning in vault')).toBeInTheDocument()
  })
})

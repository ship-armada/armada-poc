// ABOUTME: Tests for InProgressCard — empty state, non-terminal filter via pendingTxsAtom, sub-line + progress strip presence.
// ABOUTME: pendingTxsAtom is a derived atom, so seeding txListAtom drives the filter naturally.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { InProgressCard } from './InProgressCard'
import { txListAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom } from '@/state/wallet'
import type { TxRecord } from '@/lib/tx/types'

function record(
  id: string,
  state: TxRecord['executionState'],
  stage: string = 'submit-relayer',
  stagesCompleted: string[] = ['build-proof'],
): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState: state,
    stage,
    stagesCompleted,
    updatedSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount: 1_000_000n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: {
      evmAddress: '0xabc',
      railgunWalletId: 'rg',
      sourceChainId: 31337,
    },
  } as TxRecord<'shield'>
}

function renderWith(records: TxRecord[]) {
  const store = createStore()
  // V2 Phase 6: pendingTxsAtom now sources from activeTxListAtom, which filters by activeId.
  store.set(activeRailgunWalletIdAtom, 'rg')
  store.set(txListAtom, records)
  return render(
    <Provider store={store}>
      <InProgressCard />
    </Provider>,
  )
}

describe('<InProgressCard>', () => {
  it('renders the empty state when nothing is in flight', () => {
    renderWith([])
    expect(screen.getByText('All quiet')).toBeInTheDocument()
  })

  it('filters in non-terminal records only', () => {
    renderWith([
      record('a', 'active'),
      record('b', 'waiting'),
      record('c', 'completed'),
      record('d', 'failed'),
    ])
    // Two non-terminal rows render the "Pending" status chip.
    expect(screen.getAllByText('Pending').length).toBe(2)
    expect(screen.queryByText('Complete')).toBeNull()
  })

  it('renders the stage-copy sub-line for each row', () => {
    renderWith([record('a', 'waiting', 'submit-relayer')])
    // shield's submit-relayer + executionState=waiting → "Confirm in your wallet"
    expect(screen.getByText('Confirm in your wallet')).toBeInTheDocument()
  })

  it('renders the progress strip count for each row', () => {
    renderWith([record('a', 'active', 'submit-relayer', ['build-proof'])])
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })
})

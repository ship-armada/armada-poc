// ABOUTME: Tests for the tx atoms — Phase 6 scoping: activeTxListAtom + pendingTxsAtom filter to records bound to the active Railgun walletId.
// ABOUTME: A wallet switch (or lock) must produce empty surfaces synchronously, so neither the History page nor the InProgressCard leak a prior wallet's records.

import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import { txListAtom, activeTxListAtom, pendingTxsAtom } from './tx'
import { activeRailgunWalletIdAtom } from './wallet'
import type { TxRecord } from '@/lib/tx/types'

function fixture(id: string, walletId: string, executionState: TxRecord['executionState']): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState,
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof', 'submit-relayer'],
    updatedSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount: 1n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: {
      evmAddress: '0xabc',
      railgunWalletId: walletId,
      sourceChainId: 31337,
    },
  } as TxRecord<'shield'>
}

describe('activeTxListAtom (Phase 6 scoping)', () => {
  it('returns [] when no Railgun wallet is active (locked / never-unlocked)', () => {
    const store = createStore()
    store.set(txListAtom, [fixture('a', 'rg-1', 'completed')])
    store.set(activeRailgunWalletIdAtom, null)
    expect(store.get(activeTxListAtom)).toEqual([])
  })

  it('filters out records bound to other walletIds', () => {
    const store = createStore()
    store.set(txListAtom, [
      fixture('a', 'rg-1', 'completed'),
      fixture('b', 'rg-2', 'completed'),
      fixture('c', 'rg-1', 'active'),
      fixture('d', 'rg-3', 'failed'),
    ])
    store.set(activeRailgunWalletIdAtom, 'rg-1')
    const ids = store.get(activeTxListAtom).map(r => r.id).sort()
    expect(ids).toEqual(['a', 'c'])
  })

  it('flips empty the moment the active walletId clears (account-switch lock)', () => {
    const store = createStore()
    store.set(txListAtom, [fixture('a', 'rg-1', 'completed')])
    store.set(activeRailgunWalletIdAtom, 'rg-1')
    expect(store.get(activeTxListAtom)).toHaveLength(1)
    store.set(activeRailgunWalletIdAtom, null)
    expect(store.get(activeTxListAtom)).toEqual([])
  })

  it('flips to the new wallet on account-switch (rg-1 → rg-2)', () => {
    const store = createStore()
    store.set(txListAtom, [
      fixture('a', 'rg-1', 'completed'),
      fixture('b', 'rg-2', 'completed'),
    ])
    store.set(activeRailgunWalletIdAtom, 'rg-1')
    expect(store.get(activeTxListAtom).map(r => r.id)).toEqual(['a'])
    store.set(activeRailgunWalletIdAtom, 'rg-2')
    expect(store.get(activeTxListAtom).map(r => r.id)).toEqual(['b'])
  })
})

describe('pendingTxsAtom (sources from activeTxListAtom)', () => {
  it('returns only non-terminal records for the active wallet', () => {
    const store = createStore()
    store.set(txListAtom, [
      fixture('a', 'rg-1', 'completed'),
      fixture('b', 'rg-1', 'active'),
      fixture('c', 'rg-2', 'active'), // foreign wallet, should be filtered out
      fixture('d', 'rg-1', 'failed'),
    ])
    store.set(activeRailgunWalletIdAtom, 'rg-1')
    const ids = store.get(pendingTxsAtom).map(r => r.id).sort()
    expect(ids).toEqual(['b'])
  })

  it('returns [] when no wallet is active even if non-terminal records exist on disk', () => {
    const store = createStore()
    store.set(txListAtom, [fixture('a', 'rg-1', 'active')])
    store.set(activeRailgunWalletIdAtom, null)
    expect(store.get(pendingTxsAtom)).toEqual([])
  })
})

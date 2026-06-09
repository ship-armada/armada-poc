// ABOUTME: Tests for useTxHistory — Phase 6 wallet-scoped hydration. On mount/activeId change, the atom resets and re-hydrates from IDB filtered to the active walletId.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { txListAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom } from '@/state/wallet'
import type { TxRecord } from '@/lib/tx/types'

const hoisted = vi.hoisted(() => ({
  mockLoadAllTx: vi.fn<(walletId?: string) => Promise<TxRecord[]>>(async () => []),
}))

vi.mock('@/lib/tx/storage', () => ({
  loadAllTx: hoisted.mockLoadAllTx,
}))

import { useTxHistory } from './useTxHistory'

function fixture(id: string, walletId: string): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof'],
    updatedSeq: 1,
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

function Harness() {
  useTxHistory()
  return null
}

function mount(activeWalletId: string | null) {
  const store = createStore()
  store.set(activeRailgunWalletIdAtom, activeWalletId)
  const result = render(
    <Provider store={store}>
      <Harness />
    </Provider>,
  )
  return { store, ...result }
}

beforeEach(() => {
  hoisted.mockLoadAllTx.mockReset()
  hoisted.mockLoadAllTx.mockResolvedValue([])
})

describe('useTxHistory', () => {
  it('hydrates from IDB filtered to the active walletId on mount', async () => {
    hoisted.mockLoadAllTx.mockResolvedValueOnce([fixture('a', 'rg-1'), fixture('b', 'rg-1')])
    const { store } = mount('rg-1')
    await waitFor(() => {
      expect(hoisted.mockLoadAllTx).toHaveBeenCalledWith('rg-1')
    })
    await waitFor(() => {
      expect(store.get(txListAtom).map(r => r.id).sort()).toEqual(['a', 'b'])
    })
  })

  it('does NOT hit IDB when no wallet is active (locked)', () => {
    mount(null)
    expect(hoisted.mockLoadAllTx).not.toHaveBeenCalled()
  })

  it('resets txListAtom and re-hydrates when the active walletId changes', async () => {
    hoisted.mockLoadAllTx.mockImplementation(async (id?: string) => {
      if (id === 'rg-1') return [fixture('a', 'rg-1')]
      if (id === 'rg-2') return [fixture('c', 'rg-2')]
      return []
    })
    const { store } = mount('rg-1')
    await waitFor(() => {
      expect(store.get(txListAtom).map(r => r.id)).toEqual(['a'])
    })

    // Account switch (Phase 4 trigger): activeRailgunWalletIdAtom flips to rg-2.
    store.set(activeRailgunWalletIdAtom, 'rg-2')
    await waitFor(() => {
      expect(store.get(txListAtom).map(r => r.id)).toEqual(['c'])
    })
    // Critical assertion: no spillover from rg-1.
    expect(store.get(txListAtom).every(r => r.walletContext.railgunWalletId === 'rg-2')).toBe(true)
  })

  it('clears txListAtom when the active walletId goes null (lock)', async () => {
    hoisted.mockLoadAllTx.mockResolvedValueOnce([fixture('a', 'rg-1')])
    const { store } = mount('rg-1')
    await waitFor(() => {
      expect(store.get(txListAtom)).toHaveLength(1)
    })
    store.set(activeRailgunWalletIdAtom, null)
    await waitFor(() => {
      expect(store.get(txListAtom)).toEqual([])
    })
  })
})

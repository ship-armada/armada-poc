// ABOUTME: Tests for useTx.submit's follower-tab guard (P1-26) — a non-leader submit must toast, persist nothing, dispatch nothing, and return null.
// ABOUTME: Returning null is what lets the modals keep the user on the review step instead of advancing to a progress spinner nothing ever drives.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'

const executor = vi.hoisted(() => ({
  getIsLeader: vi.fn(() => false),
  executeTx: vi.fn(),
  cancelTx: vi.fn(),
  retryTx: vi.fn(),
}))
vi.mock('@/lib/tx/executor', () => executor)

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))

const storage = vi.hoisted(() => ({ putTxIfFresh: vi.fn(async () => true) }))
vi.mock('@/lib/tx/storage', () => storage)

import { useTx } from './useTx'
import { activeShieldedWalletIdAtom } from '@/state/wallet'
import { txListAtom } from '@/state/tx'

function makeWrapper(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>
}

const SHIELD_META = { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337 } as const

describe('useTx.submit follower-tab guard (P1-26)', () => {
  beforeEach(() => {
    executor.getIsLeader.mockReset()
    executor.executeTx.mockReset()
    toastMock.mockReset()
    storage.putTxIfFresh.mockReset()
    storage.putTxIfFresh.mockResolvedValue(true)
  })

  it('refuses submit on a follower tab: toasts, persists nothing, dispatches nothing, returns null', async () => {
    executor.getIsLeader.mockReturnValue(false)
    const store = createStore()
    store.set(activeShieldedWalletIdAtom, 'rw-1')
    const { result } = renderHook(() => useTx({ kind: 'shield' }), { wrapper: makeWrapper(store) })

    const id = await result.current.submit(SHIELD_META)

    expect(id).toBeNull()
    expect(toastMock).toHaveBeenCalledOnce()
    expect(executor.executeTx).not.toHaveBeenCalled()
    expect(storage.putTxIfFresh).not.toHaveBeenCalled()
    expect(store.get(txListAtom)).toEqual([])
  })

  it('on the leader tab: persists the record, dispatches the executor, returns the id', async () => {
    executor.getIsLeader.mockReturnValue(true)
    const store = createStore()
    store.set(activeShieldedWalletIdAtom, 'rw-1')
    const { result } = renderHook(() => useTx({ kind: 'shield' }), { wrapper: makeWrapper(store) })

    const id = await result.current.submit(SHIELD_META)

    expect(typeof id).toBe('string')
    expect(executor.executeTx).toHaveBeenCalledWith(id)
    expect(storage.putTxIfFresh).toHaveBeenCalledOnce()
    expect(store.get(txListAtom)).toHaveLength(1)
  })
})

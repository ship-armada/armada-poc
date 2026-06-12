// ABOUTME: Tests for usePendingTxWatcher — resumes watching persisted txs via the fallback provider after reload.
// ABOUTME: Confirms a surviving tx resolves to confirmed/failed, is cleared from storage, and fires onResolved.

import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'
import { usePendingTxWatcher } from './usePendingTxWatcher'
import { savePendingTx, loadPendingTxs, clearPendingTxs, type PendingTx } from '@/lib/pendingTx'

const CHAIN = 31337
const HASH = '0x' + '1'.repeat(64)

function seed(over: Partial<PendingTx> = {}) {
  savePendingTx({
    chainId: CHAIN,
    address: '0x' + 'a'.repeat(40),
    txHash: HASH,
    label: 'Commit participation',
    sentAt: 1,
    ...over,
  })
}

function makeProvider(waitForTransaction: ReturnType<typeof vi.fn>): JsonRpcProvider {
  return { waitForTransaction } as unknown as JsonRpcProvider
}

beforeEach(() => {
  clearPendingTxs()
})

describe('usePendingTxWatcher', () => {
  it('resolves a surviving tx to confirmed, clears it, and fires onResolved', async () => {
    seed()
    const onResolved = vi.fn()
    const provider = makeProvider(vi.fn().mockResolvedValue({ status: 1 }))

    const { result } = renderHook(() => usePendingTxWatcher(provider, CHAIN, onResolved))

    await waitFor(() => expect(result.current[0]?.status).toBe('confirmed'))
    expect(loadPendingTxs()).toEqual([])
    expect(onResolved).toHaveBeenCalled()
  })

  it('marks a reverted tx as failed and clears it', async () => {
    seed()
    const provider = makeProvider(vi.fn().mockResolvedValue({ status: 0 }))

    const { result } = renderHook(() => usePendingTxWatcher(provider, CHAIN, undefined))

    await waitFor(() => expect(result.current[0]?.status).toBe('failed'))
    expect(loadPendingTxs()).toEqual([])
  })

  it('ignores txs for a different chain', async () => {
    seed({ chainId: 1 })
    const waitForTransaction = vi.fn().mockResolvedValue({ status: 1 })
    const provider = makeProvider(waitForTransaction)

    renderHook(() => usePendingTxWatcher(provider, CHAIN, undefined))

    // Give any scan a tick; the other-chain tx must not be watched.
    await new Promise((r) => setTimeout(r, 0))
    expect(waitForTransaction).not.toHaveBeenCalled()
  })

  it('does nothing without a provider', () => {
    seed()
    const { result } = renderHook(() => usePendingTxWatcher(null, CHAIN, undefined))
    expect(result.current).toEqual([])
  })
})

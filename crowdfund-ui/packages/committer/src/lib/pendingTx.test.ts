// ABOUTME: Tests for the sessionStorage pending-tx persistence used to resume-watch broadcast txs across reloads.
// ABOUTME: Round-trips save/load/remove and tolerates malformed storage.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadPendingTxs,
  savePendingTx,
  removePendingTx,
  clearPendingTxs,
  type PendingTx,
} from './pendingTx'

const tx = (over: Partial<PendingTx> = {}): PendingTx => ({
  chainId: 31337,
  address: '0x' + 'a'.repeat(40),
  txHash: '0x' + '1'.repeat(64),
  label: 'Commit participation',
  sentAt: 1_700_000_000_000,
  ...over,
})

beforeEach(() => {
  clearPendingTxs()
})

describe('pendingTx persistence', () => {
  it('round-trips a saved tx', () => {
    const t = tx()
    savePendingTx(t)
    expect(loadPendingTxs()).toEqual([t])
  })

  it('upserts by txHash (no duplicates)', () => {
    savePendingTx(tx({ label: 'first' }))
    savePendingTx(tx({ label: 'second' }))
    const all = loadPendingTxs()
    expect(all).toHaveLength(1)
    expect(all[0].label).toBe('second')
  })

  it('keeps distinct hashes', () => {
    savePendingTx(tx({ txHash: '0x' + '1'.repeat(64) }))
    savePendingTx(tx({ txHash: '0x' + '2'.repeat(64) }))
    expect(loadPendingTxs()).toHaveLength(2)
  })

  it('removes a tx by hash', () => {
    const a = tx({ txHash: '0x' + '1'.repeat(64) })
    const b = tx({ txHash: '0x' + '2'.repeat(64) })
    savePendingTx(a)
    savePendingTx(b)
    removePendingTx(a.txHash)
    expect(loadPendingTxs()).toEqual([b])
  })

  it('returns an empty list when storage is malformed', () => {
    sessionStorage.setItem('armada.crowdfund.pendingTxs', 'not json{')
    expect(loadPendingTxs()).toEqual([])
  })
})

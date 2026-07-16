// ABOUTME: Tests for recordBroadcastHash — the cancel-then-confirm hash-preservation path (WS1.2c).
// ABOUTME: Asserts a hash obtained after a cancel is folded into a dismissed record (explorer link kept) in both the atom and IDB.

import { describe, it, expect, beforeEach } from 'vitest'
import { getDefaultStore } from 'jotai'
import { recordBroadcastHash } from './broadcast'
import type { ExecutorCtx } from './executor'
import { markCancelled } from './reducer'
import { loadAllTx, putTxIfFresh } from './storage'
import { txListAtom, upsertTxAtom } from '@/state/tx'
import { cacheClear } from '../cache'
import { setUnlocked, clear as clearKeyManager } from '../railgun/keyManager'
import type { TxRecord } from './types'

const HASH = '0xdeadbeef' as const

function unlock(walletId = 'rw-1'): void {
  const key = new Uint8Array(32)
  for (let i = 0; i < 32; i++) key[i] = (i + 3) & 0xff
  setUnlocked({
    rootSecret: new Uint8Array(32),
    walletId,
    sdkEncryptionKey: 'ff'.repeat(32),
    railgunAddress: '0zk1example',
    checksum: 'a3f2 91c8 b7e0',
    creationBlock: null,
    evmAddress: null,
    account: 0n,
    historyEncryptionKey: key,
  })
}

function record(): TxRecord<'shield'> {
  return {
    id: 'ulid-broadcast',
    kind: 'shield',
    executionState: 'active',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

/** A ctx whose upsert mirrors the executor's: atom write + OCC-guarded IDB write. */
function makeCtx(signal: AbortSignal): ExecutorCtx<'shield'> {
  const store = getDefaultStore()
  return {
    signal,
    upsert: async (rec) => {
      store.set(upsertTxAtom, rec)
      await putTxIfFresh(rec)
    },
  }
}

describe('recordBroadcastHash', () => {
  beforeEach(async () => {
    getDefaultStore().set(txListAtom, [])
    await cacheClear('txHistory')
    clearKeyManager()
    unlock()
  })

  it('normal path: patches sourceTxHash and stays in-flight', async () => {
    const store = getDefaultStore()
    const r = record()
    store.set(upsertTxAtom, r)
    await putTxIfFresh(r)

    const ac = new AbortController()
    const res = await recordBroadcastHash(r, HASH, makeCtx(ac.signal))

    expect(res.dismissed).toBe(false)
    expect(res.record.executionState).toBe('active')
    expect(res.record.artifacts.sourceTxHash).toBe(HASH)
    const persisted = await loadAllTx('rw-1')
    expect(persisted[0]!.artifacts.sourceTxHash).toBe(HASH)
  })

  it('cancel-then-confirm: folds the hash into a dismissed terminal record (atom + IDB)', async () => {
    const store = getDefaultStore()
    const r = record()
    // Simulate abortAndMark having already written a hashless cancelled record (the user clicked
    // Cancel while the non-abortable wallet prompt was still open).
    const cancelled = markCancelled(r)
    store.set(upsertTxAtom, cancelled)
    await putTxIfFresh(cancelled)

    const ac = new AbortController()
    ac.abort()
    // The handler obtains the hash AFTER the cancel, passing its now-stale stage-entry record.
    const res = await recordBroadcastHash(r, HASH, makeCtx(ac.signal))

    expect(res.dismissed).toBe(true)
    expect(res.record.executionState).toBe('cancelled')
    expect(res.record.artifacts.error?.code).toBe('DISMISSED')
    expect(res.record.artifacts.error?.txHash).toBe(HASH)
    expect(res.record.artifacts.sourceTxHash).toBe(HASH)

    const persisted = await loadAllTx('rw-1')
    expect(persisted[0]!.executionState).toBe('cancelled')
    expect(persisted[0]!.artifacts.error?.code).toBe('DISMISSED')
    expect(persisted[0]!.artifacts.sourceTxHash).toBe(HASH)
  })
})

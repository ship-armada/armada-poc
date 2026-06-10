// ABOUTME: Tests for executor — cancelTx terminal-state guard.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { cancelTx, executeTx, registerHandler, startEngine, type StageHandler } from './executor'
import { advance, markFailed } from './reducer'
import { upsertTxAtom, txListAtom } from '@/state/tx'
import { tabVisibleAtom } from '@/state/visibility'
import { cacheClear } from '../cache'
import { setUnlocked, clear as clearKeyManager } from '../railgun/keyManager'
import type { TxError, TxRecord } from './types'

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: 'ulid-test-1',
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof', 'submit-relayer'],
    updatedSeq: 5,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 30_000,
    meta: { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337 } as TxRecord<'shield'>['meta'],
    artifacts: {},
    walletContext: {
      evmAddress: '0xabc',
      railgunWalletId: 'rw-1',
      sourceChainId: 31337,
    },
    ...overrides,
  } as TxRecord
}

/** Unlock the keyManager so executor write-throughs (putTxIfFresh) succeed in tests. */
function unlockForTest(walletId = 'rw-1'): void {
  const key = new Uint8Array(32)
  for (let i = 0; i < 32; i++) key[i] = (i + 7) & 0xff
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

describe('cancelTx', () => {
  beforeEach(async () => {
    // Reset the shared default-store atoms between tests.
    const store = getDefaultStore()
    store.set(txListAtom, [])
    await cacheClear('txHistory')
    // Unlock so the cancel write-through (putTxIfFresh) doesn't reject as an unhandled error.
    clearKeyManager()
    unlockForTest()
  })

  it('does NOT clobber a record that is already in a terminal state', () => {
    const store = getDefaultStore()
    const completed = makeRecord({ executionState: 'completed', updatedSeq: 5 })
    store.set(upsertTxAtom, completed)

    cancelTx(completed.id)

    const after = store.get(txListAtom).find(t => t.id === completed.id)
    expect(after?.executionState).toBe('completed')
    expect(after?.updatedSeq).toBe(5)
  })

  it.each(['failed', 'expired', 'cancelled'] as const)(
    'leaves a %s record alone',
    (state) => {
      const store = getDefaultStore()
      const rec = makeRecord({ id: `ulid-${state}`, executionState: state, updatedSeq: 7 })
      store.set(upsertTxAtom, rec)

      cancelTx(rec.id)

      const after = store.get(txListAtom).find(t => t.id === rec.id)
      expect(after?.executionState).toBe(state)
      expect(after?.updatedSeq).toBe(7)
    },
  )

  it('cancels a non-terminal record (active)', () => {
    const store = getDefaultStore()
    const active = makeRecord({ id: 'ulid-active', executionState: 'active', updatedSeq: 3 })
    store.set(upsertTxAtom, active)

    cancelTx(active.id)

    const after = store.get(txListAtom).find(t => t.id === active.id)
    expect(after?.executionState).toBe('cancelled')
    expect(after?.updatedSeq).toBe(4)
  })
})

describe('expiry guard (P0-5)', () => {
  const SHORT_CAP = 10 * 60_000 // shield lifecycle maxDurationMs

  beforeEach(async () => {
    const store = getDefaultStore()
    store.set(txListAtom, [])
    store.set(tabVisibleAtom, true)
    await cacheClear('txHistory')
    clearKeyManager()
    unlockForTest()
    // jsdom has no navigator.locks → startEngine() elects this tab leader synchronously.
    startEngine()
  })

  // Wait until the record reaches `targetState`, then settle long enough that a buggy
  // post-stage expiry write (which lands a macrotask later through IDB) would overwrite it.
  // The buggy path transiently shows the handler's terminal state before clobbering it to
  // `expired`, so a bare waitFor would false-pass; the trailing settle is what makes this RED.
  async function waitTerminalThenSettle(id: string, targetState: string): Promise<TxRecord | undefined> {
    const store = getDefaultStore()
    await vi.waitFor(() => {
      const r = store.get(txListAtom).find(t => t.id === id)
      expect(r?.executionState).toBe(targetState)
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    return store.get(txListAtom).find(t => t.id === id)
  }

  it('does not clobber a record the handler just completed, even past maxDurationMs', async () => {
    const store = getDefaultStore()
    // Handler advances the record straight to terminal success.
    const handler: StageHandler<'shield'> = {
      kind: 'shield',
      resumableFrom: ['submit-relayer'],
      run: async (record, ctx) => {
        await ctx.upsert(advance(record, 'hub-confirmed'))
      },
    }
    registerHandler(handler)

    const rec = makeRecord({
      id: 'ulid-expire-complete',
      executionState: 'active',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 1,
      // createdAt well past the 10-min cap — the buggy path would mark this expired.
      createdAt: Date.now() - (SHORT_CAP + 60_000),
    })
    store.set(upsertTxAtom, rec)

    executeTx(rec.id)

    const after = await waitTerminalThenSettle(rec.id, 'completed')
    expect(after?.executionState).toBe('completed')
    // Exactly one transition (the handler's advance) — no clobbering expiry write on top.
    expect(after?.updatedSeq).toBe(2)
  })

  it('does not clobber a record the handler just failed, preserving the TxError', async () => {
    const store = getDefaultStore()
    const txError: TxError = { code: 'TX_REVERTED', message: 'reverted on chain' }
    const handler: StageHandler<'shield'> = {
      kind: 'shield',
      resumableFrom: ['submit-relayer'],
      run: async (record, ctx) => {
        await ctx.upsert(markFailed(record, txError))
      },
    }
    registerHandler(handler)

    const rec = makeRecord({
      id: 'ulid-expire-fail',
      executionState: 'active',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 1,
      createdAt: Date.now() - (SHORT_CAP + 60_000),
    })
    store.set(upsertTxAtom, rec)

    executeTx(rec.id)

    const after = await waitTerminalThenSettle(rec.id, 'failed')
    expect(after?.executionState).toBe('failed')
    expect(after?.artifacts.error?.code).toBe('TX_REVERTED')
    expect(after?.artifacts.error?.message).toBe('reverted on chain')
    expect(after?.updatedSeq).toBe(2)
  })
})

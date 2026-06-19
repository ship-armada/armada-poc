// ABOUTME: Tests for executor — cancelTx terminal-state guard.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { __setIsLeaderForTests, canRetryTx, cancelAllRunning, cancelTx, executeTx, registerHandler, resumeForWallet, retryTx, startEngine, type StageHandler } from './executor'
import { advance, markFailed } from './reducer'
import { putTx, loadAllTx } from './storage'
import { upsertTxAtom, txListAtom } from '@/state/tx'
import { tabVisibleAtom } from '@/state/visibility'
import { cacheClear } from '../cache'
import { setUnlocked, clear as clearKeyManager } from '../railgun/keyManager'
import { isTerminalState, type TxError, type TxRecord } from './types'

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

describe('retryTx (P0-4)', () => {
  beforeEach(async () => {
    const store = getDefaultStore()
    store.set(txListAtom, [])
    // Park the chain at the visibility gate so the (module-registered) handler doesn't run and
    // mutate the record out from under the synchronous assertions below.
    store.set(tabVisibleAtom, false)
    await cacheClear('txHistory')
    clearKeyManager()
    unlockForTest()
  })

  it('accepts a retry from a retryable failed stage and marks the record retrying', () => {
    const store = getDefaultStore()
    // shield's retryableStages = ['submit-relayer'].
    const rec = makeRecord({ id: 'retry-ok', executionState: 'failed', stage: 'submit-relayer', updatedSeq: 4 })
    store.set(upsertTxAtom, rec)

    const accepted = retryTx('retry-ok')

    expect(accepted).toBe(true)
    const after = store.get(txListAtom).find(t => t.id === 'retry-ok')
    expect(after?.executionState).toBe('retrying')
    expect(after?.updatedSeq).toBe(5)
  })

  it('refuses a retry from a non-retryable stage and leaves the record failed', () => {
    const store = getDefaultStore()
    const rec = makeRecord({ id: 'retry-no', executionState: 'failed', stage: 'build-proof', updatedSeq: 4 })
    store.set(upsertTxAtom, rec)

    const accepted = retryTx('retry-no')

    expect(accepted).toBe(false)
    const after = store.get(txListAtom).find(t => t.id === 'retry-no')
    expect(after?.executionState).toBe('failed')
    expect(after?.updatedSeq).toBe(4)
  })

  it('refuses a retry for an unknown id', () => {
    expect(retryTx('does-not-exist')).toBe(false)
  })
})

describe('resumeForWallet (P0-2)', () => {
  const SHORT_CAP = 10 * 60_000

  beforeEach(async () => {
    const store = getDefaultStore()
    store.set(txListAtom, [])
    // Park the chain at the visibility gate so a resumed (has-hash) record's handler doesn't run
    // and mutate it — we only assert which resume branch was taken.
    store.set(tabVisibleAtom, false)
    await cacheClear('txHistory')
    clearKeyManager()
  })

  // Each test uses a fresh walletId — resumeForWallet is idempotent per (walletId, session) via a
  // module-scope Set with no test reset, so reusing an id would early-return.
  function recordFor(walletId: string, overrides: Partial<TxRecord> = {}): TxRecord {
    return makeRecord({
      walletContext: { evmAddress: '0xabc', railgunWalletId: walletId, sourceChainId: 31337 },
      ...overrides,
    })
  }

  it('resumes a broadcast (has-hash) record without terminalizing it', async () => {
    const store = getDefaultStore()
    const walletId = 'rw-resume-hash'
    unlockForTest(walletId)
    startEngine() // elect leader (no navigator.locks in jsdom)
    const rec = recordFor(walletId, {
      id: 'res-hash',
      executionState: 'waiting',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 4,
      createdAt: Date.now() - 30_000, // within budget
      artifacts: { sourceTxHash: '0xfeed' },
    })
    await putTx(rec)

    await resumeForWallet(walletId)

    // Has-hash branch: re-attach the watcher (executeTx). It must NOT be marked failed/expired.
    const after = await loadAllTx(walletId)
    expect(after).toHaveLength(1)
    expect(isTerminalState(after[0]!.executionState)).toBe(false)
    expect(after[0]!.artifacts.sourceTxHash).toBe('0xfeed')
  })

  it('marks a pre-broadcast (no-hash) record failed with INTERRUPTED', async () => {
    const walletId = 'rw-resume-nohash'
    unlockForTest(walletId)
    startEngine()
    const rec = recordFor(walletId, {
      id: 'res-nohash',
      executionState: 'active',
      stage: 'build-proof',
      stagesCompleted: [],
      updatedSeq: 1,
      createdAt: Date.now() - 30_000,
      artifacts: {},
    })
    await putTx(rec)

    await resumeForWallet(walletId)

    const after = await loadAllTx(walletId)
    expect(after[0]!.executionState).toBe('failed')
    expect(after[0]!.artifacts.error?.code).toBe('INTERRUPTED')
    // Auto-lock regression guard: a terminalized record can't keep pendingTxsAtom non-empty.
    expect(isTerminalState(after[0]!.executionState)).toBe(true)
  })

  it('expires a record past its lifecycle budget (even with a hash)', async () => {
    const walletId = 'rw-resume-expired'
    unlockForTest(walletId)
    startEngine()
    const rec = recordFor(walletId, {
      id: 'res-expired',
      executionState: 'waiting',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 4,
      createdAt: Date.now() - (SHORT_CAP + 60_000), // over the 10-min cap
      artifacts: { sourceTxHash: '0xfeed' },
    })
    await putTx(rec)

    await resumeForWallet(walletId)

    const after = await loadAllTx(walletId)
    expect(after[0]!.executionState).toBe('expired')
  })

  it('is a no-op while locked (no key to decrypt records)', async () => {
    const store = getDefaultStore()
    // Seed under one wallet, then lock.
    const walletId = 'rw-resume-locked'
    unlockForTest(walletId)
    await putTx(recordFor(walletId, { id: 'res-locked', executionState: 'active', stage: 'build-proof', updatedSeq: 1, artifacts: {} }))
    clearKeyManager()
    store.set(txListAtom, [])

    await resumeForWallet(walletId)

    // Locked → loadAllTx returns [] → nothing seeded or written.
    expect(store.get(txListAtom)).toEqual([])
  })
})

describe('cancelAllRunning (P1-15)', () => {
  // A handler that parks until aborted — keeps the record in the executor's `running` set so
  // cancelAllRunning has something to tear down, then resolves cleanly when the signal fires.
  const parkUntilAbort: StageHandler<'shield'> = {
    kind: 'shield',
    resumableFrom: ['submit-relayer'],
    run: (_record, ctx) =>
      new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve()
        ctx.signal.addEventListener('abort', () => resolve(), { once: true })
      }),
  }

  beforeEach(async () => {
    const store = getDefaultStore()
    store.set(txListAtom, [])
    store.set(tabVisibleAtom, true)
    await cacheClear('txHistory')
    clearKeyManager()
    unlockForTest()
    startEngine()
    registerHandler(parkUntilAbort)
  })

  it('cancels a pre-broadcast record and dismisses a broadcast one (keeping the hash)', () => {
    const store = getDefaultStore()
    const pre = makeRecord({ id: 'ca-pre', executionState: 'active', stage: 'submit-relayer', updatedSeq: 1, artifacts: {} })
    const post = makeRecord({ id: 'ca-post', executionState: 'active', stage: 'submit-relayer', updatedSeq: 1, artifacts: { sourceTxHash: '0xfeed' } })
    store.set(upsertTxAtom, pre)
    store.set(upsertTxAtom, post)
    executeTx('ca-pre')
    executeTx('ca-post')

    cancelAllRunning('account-switch')

    // abortAndMark writes the atom synchronously; assert immediately.
    const after = (id: string) => store.get(txListAtom).find(t => t.id === id)
    expect(after('ca-pre')?.executionState).toBe('cancelled')
    expect(after('ca-pre')?.artifacts.error?.code).toBe('CANCELLED')
    expect(after('ca-post')?.executionState).toBe('cancelled')
    expect(after('ca-post')?.artifacts.error?.code).toBe('DISMISSED')
    expect(after('ca-post')?.artifacts.error?.txHash).toBe('0xfeed')
  })

  it('is a no-op when nothing is running', () => {
    // No executeTx calls → empty running set → no throw, no writes.
    expect(() => cancelAllRunning('account-switch')).not.toThrow()
  })
})

describe('canRetryTx — fee-expired / duplicate are non-retryable (S-H1)', () => {
  // A failed `submit-relayer` is normally retryable (the stage is in retryableStages).
  function failedAtSubmit(error?: TxError): TxRecord {
    return makeRecord({
      executionState: 'failed',
      stage: 'submit-relayer',
      artifacts: error ? { error } : {},
    })
  }

  it('allows retry for an ordinary failure at a retryable stage', () => {
    // WHY: baseline — RPC_ERROR / OTHER at submit-relayer can legitimately re-send.
    expect(canRetryTx(failedAtSubmit({ code: 'RPC_ERROR', message: 'relayer 502' }))).toBe(true)
    expect(canRetryTx(failedAtSubmit())).toBe(true)
  })

  it('refuses retry for FEE_EXPIRED — re-POSTing the baked-in expired quote loops forever (S-H1)', () => {
    // WHY (S-H1): the proof embeds the fee cacheId + amount; once the relayer rejects it as
    // expired/insufficient, every retry re-fails identically. Only a fresh transaction recovers.
    expect(canRetryTx(failedAtSubmit({ code: 'FEE_EXPIRED', message: 'quote expired' }))).toBe(false)
  })

  it('refuses retry for DUPLICATE_TX — the tx is already in flight (recover via /status, T-M3)', () => {
    expect(canRetryTx(failedAtSubmit({ code: 'DUPLICATE_TX', message: 'already submitted' }))).toBe(false)
  })
})

describe('retryTx — follower-tab leader guard (T-H3)', () => {
  beforeEach(async () => {
    const store = getDefaultStore()
    store.set(txListAtom, [])
    store.set(tabVisibleAtom, false)
    await cacheClear('txHistory')
    clearKeyManager()
    unlockForTest()
  })

  it('refuses retry on a follower tab and does NOT wedge the record in retrying', () => {
    // WHY (T-H3): on a follower, executeTx is a no-op. If retryTx still marked the record
    // `retrying`, it would sit non-terminal forever — counted by pendingTxsAtom, deferring
    // auto-lock and holding keys in memory. The guard must refuse before markRetrying.
    __setIsLeaderForTests(false)
    try {
      const store = getDefaultStore()
      const failed = makeRecord({
        id: 'ulid-follower-retry',
        executionState: 'failed',
        stage: 'submit-relayer', // retryable stage — so only the leader guard can refuse here
        updatedSeq: 3,
      })
      store.set(upsertTxAtom, failed)

      expect(retryTx(failed.id)).toBe(false)

      const after = store.get(txListAtom).find(t => t.id === failed.id)
      expect(after?.executionState).toBe('failed') // not 'retrying' — no wedge
      expect(after?.updatedSeq).toBe(3) // untouched
    } finally {
      __setIsLeaderForTests(true) // restore for any subsequent state
    }
  })
})

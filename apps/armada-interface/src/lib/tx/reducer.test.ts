// ABOUTME: Reducer tests — patchArtifacts cursor pattern + typed-error mark transitions (markFailed string|TxError, markCancelled, markDismissed).

import { describe, it, expect } from 'vitest'
import { advance, markCancelled, markDismissed, markFailed, markRecoveredComplete, markWaiting, patchArtifacts, sourceHashProvesComplete } from './reducer'
import { lifecycleFor } from './lifecycles'
import type { TxRecord } from './types'

function baseXchainRecord(): TxRecord<'unshield-xchain'> {
  return {
    id: '01TESTID00000000000000',
    kind: 'unshield-xchain',
    executionState: 'pending',
    stage: 'iris-attestation-pending',
    stagesCompleted: ['build-proof', 'submit-relayer', 'hub-burn-confirmed'],
    updatedSeq: 7,
    createdAt: 1_000_000,
    updatedAt: 1_000_500,
    meta: {
      amount: 1_000_000n,
      feeCacheId: 'fee-1',
      toChainId: 84532,
      recipient: '0x0000000000000000000000000000000000000001',
      broadcasterFeeAmount: 50_000n,
      broadcasterRailgunAddress: '0zk' + 'a'.repeat(64),
    },
    artifacts: {
      sourceTxHash: '0xabc' as `0x${string}`,
      cctpNonce: '0xnonce' as `0x${string}`,
      destFromBlock: '1000',
    },
    walletContext: {
      evmAddress: '0xeve',
      railgunWalletId: 'wallet-1',
      sourceChainId: 31337,
    },
  }
}

describe('patchArtifacts', () => {
  it('merges new artifact values without touching stage or executionState', () => {
    const r = markWaiting(baseXchainRecord())
    const seqBefore = r.updatedSeq

    const next = patchArtifacts(r, { destFromBlock: '6000' })

    expect(next.stage).toBe(r.stage)
    expect(next.executionState).toBe('waiting')
    expect(next.artifacts.destFromBlock).toBe('6000')
    expect(next.artifacts.cctpNonce).toBe('0xnonce') // preserved
    expect(next.artifacts.sourceTxHash).toBe('0xabc') // preserved
    expect(next.updatedSeq).toBe(seqBefore + 1)
  })

  it('does not mutate the input record', () => {
    const r = baseXchainRecord()
    const snapshot = JSON.parse(JSON.stringify(r, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ))

    patchArtifacts(r, { destFromBlock: '9999' })

    const after = JSON.parse(JSON.stringify(r, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ))
    expect(after).toEqual(snapshot)
  })

  it('supports a chained sequence of patches (cursor pattern)', () => {
    let cursor = markWaiting(baseXchainRecord())
    cursor = patchArtifacts(cursor, { destFromBlock: '5000' })
    cursor = patchArtifacts(cursor, { destFromBlock: '6000' })
    cursor = patchArtifacts(cursor, { destFromBlock: '7000' })

    expect(cursor.artifacts.destFromBlock).toBe('7000')
    expect(cursor.executionState).toBe('waiting')
    // Three patches after markWaiting (which itself bumped once).
    expect(cursor.updatedSeq).toBe(7 + 1 + 3)
  })
})

describe('patchArtifacts → advance OCC chaining', () => {
  // WHY THIS SUITE EXISTS: a regression introduced in PR #288 had every handler do
  //   await ctx.upsert(patchArtifacts(record, { sourceTxHash }))   // writes seq N+1
  //   await waitForReceiptOrFail(...)
  //   const completed = advance(record, terminalStage, {...})       // built from STALE record
  //   await ctx.upsert(completed)                                    // OCC-rejects (equal seq)
  // The atom/IDB silently dropped the terminal advance; the executor re-read the record at
  // executionState='active', stage='submit-relayer', and looped — re-prompting the user to
  // sign the same tx forever. These tests pin the invariant the fix relies on: chained
  // reducer ops MUST produce strictly-increasing updatedSeq, but ONLY when each op is built
  // from the latest local copy. If a future refactor reverts `advance(broadcastRecord, …)`
  // to `advance(record, …)`, the seq-collision test below fails loudly.

  it('patchArtifacts → advance(patched, …) produces strictly-increasing updatedSeq', () => {
    // Setup a shield record at 'submit-relayer' so we can advance to 'hub-confirmed'.
    const base: TxRecord<'shield'> = {
      id: '01TESTSHIELD0000000000',
      kind: 'shield',
      executionState: 'active',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 5,
      createdAt: 1_000_000,
      updatedAt: 1_000_100,
      meta: { amount: 1_000_000n, fromChainId: 11155111, feeCacheId: 'fee-1' },
      artifacts: {},
      walletContext: {
        evmAddress: '0xeve',
        railgunWalletId: 'wallet-1',
        sourceChainId: 11155111,
      },
    }

    const patched = patchArtifacts(base, { sourceTxHash: '0xdeadbeef' as `0x${string}` })
    expect(patched.updatedSeq).toBe(6)

    // CORRECT pattern — build advance from the patched record.
    const advancedCorrectly = advance(patched, 'hub-confirmed', { sourceTxHash: '0xdeadbeef' as `0x${string}` })
    expect(advancedCorrectly.updatedSeq).toBe(7)
    expect(advancedCorrectly.executionState).toBe('completed')
  })

  it('patchArtifacts → advance(record, …) [the BUG pattern] produces equal updatedSeq — OCC would silently drop the advance', () => {
    // This test demonstrates the regression that motivated the suite. If a future change
    // reverts a handler back to passing the STALE record into the final advance, this test
    // documents what happens: both reducer outputs share updatedSeq=6, and upsertTxAtom /
    // putTxIfFresh would silently drop the advance — leaving the executor stuck.
    const base: TxRecord<'shield'> = {
      id: '01TESTSHIELD0000000001',
      kind: 'shield',
      executionState: 'active',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 5,
      createdAt: 1_000_000,
      updatedAt: 1_000_100,
      meta: { amount: 1_000_000n, fromChainId: 11155111, feeCacheId: 'fee-1' },
      artifacts: {},
      walletContext: {
        evmAddress: '0xeve',
        railgunWalletId: 'wallet-1',
        sourceChainId: 11155111,
      },
    }

    const patched = patchArtifacts(base, { sourceTxHash: '0xdeadbeef' as `0x${string}` })
    const advancedFromStale = advance(base, 'hub-confirmed', { sourceTxHash: '0xdeadbeef' as `0x${string}` })

    // Both end at seq 6. The atom's `existing.updatedSeq >= record.updatedSeq` check would
    // reject the second write. This is the invariant a regression would break.
    expect(patched.updatedSeq).toBe(6)
    expect(advancedFromStale.updatedSeq).toBe(6)
    expect(patched.updatedSeq).toBe(advancedFromStale.updatedSeq) // the collision
  })
})

describe('markFailed — typed error', () => {
  it('wraps a bare string as { code: "OTHER", message } for backward compatibility', () => {
    // Legacy call sites can still pass a string; the reducer normalises rather than forcing a
    // big-bang rewrite of every handler. Important for incremental rollout.
    const r = markFailed(baseXchainRecord(), 'raw error from somewhere')
    expect(r.executionState).toBe('failed')
    expect(r.artifacts.error).toEqual({ code: 'OTHER', message: 'raw error from somewhere' })
  })

  it('passes a typed TxError through unchanged', () => {
    // The handler classifier should be able to set POLL_TIMEOUT or TX_REVERTED with a txHash;
    // the reducer must not lose those fields by re-wrapping.
    const txErr = { code: 'POLL_TIMEOUT' as const, message: 'lost track', txHash: '0xfeed' as `0x${string}` }
    const r = markFailed(baseXchainRecord(), txErr)
    expect(r.artifacts.error).toEqual(txErr)
  })
})

describe('markCancelled vs markDismissed', () => {
  it('markCancelled writes a CANCELLED-coded error to distinguish from internal cleanup paths', () => {
    // The error code differentiates "user explicitly clicked Cancel" from other cancellation
    // origins (auto-lock, tab close). UI can choose to render specific copy.
    const r = markCancelled(baseXchainRecord())
    expect(r.executionState).toBe('cancelled')
    expect(r.artifacts.error?.code).toBe('CANCELLED')
    expect(r.artifacts.error?.txHash).toBeUndefined()
  })

  it('markDismissed writes a DISMISSED error AND carries forward sourceTxHash for explorer linking', () => {
    // The whole point of dismiss-vs-cancel: the on-chain tx is still running. We MUST preserve
    // the txHash so the user can find it on the explorer; otherwise dismissing post-broadcast
    // strands them with no recovery path.
    const r = markDismissed(baseXchainRecord()) // baseXchainRecord has sourceTxHash: '0xabc'
    expect(r.executionState).toBe('cancelled')
    expect(r.artifacts.error?.code).toBe('DISMISSED')
    expect(r.artifacts.error?.txHash).toBe('0xabc')
  })

  it('markDismissed handles a record without sourceTxHash by omitting txHash from the error', () => {
    // Edge case: dismissing a pre-broadcast record (TxActions wouldn't render the dismiss
    // button in this state, but the reducer is defensive). Should not synthesise a bogus hash.
    const r = baseXchainRecord()
    delete (r.artifacts as { sourceTxHash?: `0x${string}` }).sourceTxHash
    const dismissed = markDismissed(r)
    expect(dismissed.artifacts.error?.code).toBe('DISMISSED')
    expect(dismissed.artifacts.error?.txHash).toBeUndefined()
  })
})

describe('markRecoveredComplete (P1-24)', () => {
  it('upgrades a terminated-but-confirmed record to completed, dropping the stale error', () => {
    // WHY: history recovery found this tx on chain, but locally it had expired/failed because we
    // lost the watcher. Upgrade IN PLACE — terminal-success stage, no stale error, sourceTxHash
    // preserved — rather than leaving a permanent false "expired" or inserting a duplicate row.
    const r: TxRecord<'unshield-xchain'> = {
      ...baseXchainRecord(),
      executionState: 'expired',
      stage: 'iris-attestation-pending',
      artifacts: {
        sourceTxHash: '0xabc' as `0x${string}`,
        error: { code: 'POLL_TIMEOUT', message: 'lost track' },
      },
    }
    const upgraded = markRecoveredComplete(r)
    expect(upgraded.executionState).toBe('completed')
    expect(upgraded.stage).toBe(lifecycleFor('unshield-xchain').terminalSuccess)
    expect(upgraded.artifacts.error).toBeUndefined()
    expect(upgraded.artifacts.sourceTxHash).toBe('0xabc')
    expect(upgraded.updatedSeq).toBe(r.updatedSeq + 1)
  })
})

describe('sourceHashProvesComplete (T-H1)', () => {
  it('is true for same-chain kinds (the source tx IS the terminal event)', () => {
    // WHY: history recovery may upgrade these from a sourceTxHash match — the hub tx landing
    // proves the whole tx completed.
    for (const kind of ['shield', 'unshield-local', 'transfer-shielded', 'yield-deposit', 'yield-withdraw'] as const) {
      expect(sourceHashProvesComplete(kind)).toBe(true)
    }
  })

  it('is false for cross-chain kinds (sourceTxHash is only the burn leg)', () => {
    // WHY (T-H1): the matched hash is the burn; CCTP delivery on the destination chain is a
    // separate leg. Recovery must NOT force-complete these or it paints a false "Funds delivered".
    expect(sourceHashProvesComplete('shield-xchain')).toBe(false)
    expect(sourceHashProvesComplete('unshield-xchain')).toBe(false)
  })
})

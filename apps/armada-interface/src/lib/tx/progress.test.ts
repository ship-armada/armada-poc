// ABOUTME: Tests for the proof-progress writer — bucketed atom writes plus the abort-aware no-op.
// ABOUTME: The abort guard (WS1.2b) stops a mid-proof cancel from being flipped back to active by a late SDK onProgress callback.

import { describe, it, expect, beforeEach } from 'vitest'
import { getDefaultStore } from 'jotai'
import { createProofProgressWriter } from './progress'
import { txListAtom, upsertTxAtom } from '@/state/tx'
import type { TxRecord } from './types'

function record(): TxRecord<'shield'> {
  return {
    id: 'ulid-progress',
    kind: 'shield',
    executionState: 'active',
    stage: 'build-proof',
    stagesCompleted: [],
    updatedSeq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

describe('createProofProgressWriter', () => {
  beforeEach(() => {
    getDefaultStore().set(txListAtom, [])
  })

  it('writes bucketed progress to the atom and bumps updatedSeq', () => {
    const store = getDefaultStore()
    const r = record()
    store.set(upsertTxAtom, r)
    const writer = createProofProgressWriter(r)
    writer.write(0.25)
    const after = store.get(txListAtom).find(t => t.id === r.id)
    expect(after?.artifacts.proofProgress).toBe(0.2)
    expect(after?.updatedSeq).toBe(2)
  })

  it('no-ops once the abort signal fires — cannot resurrect a cancelled record (WS1.2b)', () => {
    const store = getDefaultStore()
    const r = record()
    store.set(upsertTxAtom, r)
    const ac = new AbortController()
    const writer = createProofProgressWriter(r, ac.signal)
    ac.abort()
    writer.write(0.5)
    const after = store.get(txListAtom).find(t => t.id === r.id)
    expect(after?.artifacts.proofProgress).toBeUndefined()
    expect(after?.updatedSeq).toBe(1)
  })
})

// ABOUTME: Store-level tests for the tx pipeline engine — sequencing, fail-stop, single-flight, detach-pause/resume, abort.
// ABOUTME: Drives the engine against a bare Jotai store (no React) using deferred tx receipts to interleave events.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createStore } from 'jotai'
import { loadPendingTxs, clearPendingTxs } from '@/lib/pendingTx'
import {
  runTxPipeline,
  setPipelineAttached,
  abortPipelinesForOtherAddress,
  retryTxPipeline,
  clearAllPipelines,
  getPipelineState,
  type TxStep,
} from './useTxPipeline'

const A = '0x' + 'a'.repeat(40)

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// A step whose receipt is controllable via `wait`. `send` is a spy so tests can
// assert a later step was never prompted.
function makeStep(
  label: string,
  wait: () => Promise<unknown>,
  onReceipt?: (logs: readonly unknown[]) => void,
): { step: TxStep; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue({ hash: `0x${label}`, wait })
  return {
    step: { label, send, onReceipt: onReceipt as TxStep['onReceipt'] },
    send,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
async function waitFor(fn: () => boolean, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await flush()
  }
  throw new Error('waitFor: condition not met in time')
}

let store: ReturnType<typeof createStore>

beforeEach(() => {
  store = createStore()
  clearAllPipelines()
  clearPendingTxs()
})

describe('tx pipeline store', () => {
  it('runs steps in order and resolves to success, ingesting commit receipts', async () => {
    const receipt = (s: number) => () => Promise.resolve({ status: 1, logs: [{ i: s }] })
    const onReceiptB = vi.fn()
    const onReceiptC = vi.fn()
    const a = makeStep('approve', receipt(0))
    const b = makeStep('commit1', receipt(1), onReceiptB)
    const c = makeStep('commit2', receipt(2), onReceiptC)

    runTxPipeline(store, { address: A, steps: [a.step, b.step, c.step] })
    await waitFor(() => getPipelineState(store, A).phase === 'success')

    const { rows } = getPipelineState(store, A)
    expect(rows.map((r) => r.status)).toEqual(['done', 'done', 'done'])
    expect(onReceiptB).toHaveBeenCalledOnce()
    expect(onReceiptC).toHaveBeenCalledOnce()
    // Order: approve sent before commit1 before commit2.
    expect(a.send.mock.invocationCallOrder[0]).toBeLessThan(b.send.mock.invocationCallOrder[0])
    expect(b.send.mock.invocationCallOrder[0]).toBeLessThan(c.send.mock.invocationCallOrder[0])
  })

  it('stops at the failing row and does not send later steps', async () => {
    const a = makeStep('approve', () => Promise.resolve({ status: 1, logs: [] }))
    const b = makeStep('commit1', () => Promise.resolve({ status: 0, logs: [] })) // revert
    const c = makeStep('commit2', () => Promise.resolve({ status: 1, logs: [] }))

    runTxPipeline(store, { address: A, steps: [a.step, b.step, c.step] })
    await waitFor(() => getPipelineState(store, A).phase === 'error')

    const { rows } = getPipelineState(store, A)
    expect(rows[0].status).toBe('done')
    expect(rows[1].status).toBe('error')
    expect(rows[2].status).toBe('pending')
    expect(c.send).not.toHaveBeenCalled()
  })

  it('is single-flight per address — a second run while running is ignored', async () => {
    const d = deferred<unknown>()
    const a = makeStep('approve', () => d.promise)
    runTxPipeline(store, { address: A, steps: [a.step] })
    await waitFor(() => a.send.mock.calls.length === 1)

    // Second run for the same address while the first is in flight: ignored.
    const other = makeStep('other', () => Promise.resolve({ status: 1, logs: [] }))
    runTxPipeline(store, { address: A, steps: [other.step] })

    d.resolve({ status: 1, logs: [] })
    await waitFor(() => getPipelineState(store, A).phase === 'success')
    expect(other.send).not.toHaveBeenCalled()
  })

  it('pauses on detach before the next send and resumes on re-attach', async () => {
    const d1 = deferred<unknown>()
    const a = makeStep('approve', () => d1.promise)
    const b = makeStep('commit1', () => Promise.resolve({ status: 1, logs: [] }))

    runTxPipeline(store, { address: A, steps: [a.step, b.step] })
    await waitFor(() => a.send.mock.calls.length === 1)

    // Detach (modal closed) while the approve receipt is still pending.
    setPipelineAttached(store, A, false)
    d1.resolve({ status: 1, logs: [] })

    await waitFor(() => getPipelineState(store, A).phase === 'paused')
    expect(b.send).not.toHaveBeenCalled()
    // Re-attach returns the live rows (approve done) and resumes.
    expect(getPipelineState(store, A).rows[0].status).toBe('done')

    setPipelineAttached(store, A, true)
    await waitFor(() => getPipelineState(store, A).phase === 'success')
    expect(b.send).toHaveBeenCalledOnce()
  })

  it('aborts (without sending more) when the connected address changes', async () => {
    const d1 = deferred<unknown>()
    const a = makeStep('approve', () => d1.promise)
    const b = makeStep('commit1', () => Promise.resolve({ status: 1, logs: [] }))

    runTxPipeline(store, { address: A, steps: [a.step, b.step] })
    await waitFor(() => a.send.mock.calls.length === 1)

    // Wallet switched to a different account.
    abortPipelinesForOtherAddress(store, '0x' + 'b'.repeat(40))
    d1.resolve({ status: 1, logs: [] })

    await waitFor(() => getPipelineState(store, A).phase === 'aborted')
    expect(b.send).not.toHaveBeenCalled()
  })

  it('persists a broadcast tx and clears it once confirmed', async () => {
    const d = deferred<unknown>()
    const a = makeStep('approve', () => d.promise)
    runTxPipeline(store, { address: A, steps: [a.step] })

    // Once broadcast (hash known), the tx is persisted for reload resume-watch.
    await waitFor(() => loadPendingTxs().some((t) => t.txHash === '0xapprove'))

    d.resolve({ status: 1, logs: [] })
    await waitFor(() => getPipelineState(store, A).phase === 'success')
    // Confirmed → no longer pending.
    expect(loadPendingTxs()).toEqual([])
  })

  it('retry resumes from the failed row and keeps earlier successes', async () => {
    let commitAttempts = 0
    const a = makeStep('approve', () => Promise.resolve({ status: 1, logs: [] }))
    // commit1 reverts the first time, succeeds on retry.
    const b = makeStep('commit1', () => {
      commitAttempts += 1
      return Promise.resolve({ status: commitAttempts === 1 ? 0 : 1, logs: [] })
    })

    runTxPipeline(store, { address: A, steps: [a.step, b.step] })
    await waitFor(() => getPipelineState(store, A).phase === 'error')
    expect(getPipelineState(store, A).rows[1].status).toBe('error')

    retryTxPipeline(store, A)
    await waitFor(() => getPipelineState(store, A).phase === 'success')

    // approve sent once (not re-sent), commit retried.
    expect(a.send).toHaveBeenCalledOnce()
    expect(b.send).toHaveBeenCalledTimes(2)
    expect(getPipelineState(store, A).rows.map((r) => r.status)).toEqual(['done', 'done'])
  })
})

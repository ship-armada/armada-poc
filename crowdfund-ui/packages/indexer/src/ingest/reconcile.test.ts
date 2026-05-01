// ABOUTME: Unit tests for auto-reconcile classification, backoff, and end-to-end behavior.
// ABOUTME: Verifies bounded retries, deferred ranges, and exhausted ranges across poll cycles.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileIndexerStore } from '../db/fileStore.js'
import {
  autoReconcileGaps,
  classifyRepairableRanges,
  computeNextRetryAt,
  getExhaustedRepairRanges,
} from './reconcile.js'
import type { CursorState, IngestRangeRecord } from '../types.js'
import type { RangeLogProvider, RpcLog } from './rpc.js'

const tempDirs: string[] = []

const cursor: CursorState = {
  deployBlock: 100,
  confirmationDepth: 12,
  overlapWindow: 100,
  chainHead: 150,
  confirmedHead: 138,
  ingestedCursor: 99,
  verifiedCursor: 99,
}

const config = {
  chainId: 11155111,
  contractAddress: '0xF681A7c700420e5CA93f77c8988d3eED02767035',
  providerName: 'primary',
}

const baseOptions = {
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
}

function makeRange(overrides: Partial<IngestRangeRecord>): IngestRangeRecord {
  return {
    fromBlock: 100,
    toBlock: 109,
    status: 'failed',
    provider: 'primary',
    attempts: 1,
    logCount: 0,
    digest: null,
    fetchedAt: '2026-05-01T00:00:00.000Z',
    verifiedAt: null,
    lastError: 'RPC timeout',
    nextRetryAt: null,
    ...overrides,
  }
}

function makeRpcLog(blockNumber: number): RpcLog {
  return {
    blockNumber,
    blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionHash: '0x' + (blockNumber + 1).toString(16).padStart(64, '0'),
    index: 0,
    topics: ['0x' + '33'.repeat(32)],
    data: '0x',
  }
}

function makeProvider(logs: readonly RpcLog[], blockNumber = 150): RangeLogProvider {
  return {
    getBlockNumber: async () => blockNumber,
    getLogs: async () => logs,
  }
}

async function makeStore(): Promise<FileIndexerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'crowdfund-indexer-reconcile-'))
  tempDirs.push(dir)
  return new FileIndexerStore({
    path: join(dir, 'store.json'),
    initialCursor: cursor,
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('computeNextRetryAt', () => {
  it('produces exponential delays from the configured base', () => {
    const now = new Date('2026-05-01T00:00:00.000Z')
    expect(computeNextRetryAt(1, baseOptions, now)).toBe('2026-05-01T00:00:01.000Z') // 1 * base
    expect(computeNextRetryAt(2, baseOptions, now)).toBe('2026-05-01T00:00:02.000Z') // 2 * base
    expect(computeNextRetryAt(3, baseOptions, now)).toBe('2026-05-01T00:00:04.000Z') // 4 * base
    expect(computeNextRetryAt(4, baseOptions, now)).toBe('2026-05-01T00:00:08.000Z') // 8 * base
  })

  it('caps the delay at backoffMaxMs', () => {
    const now = new Date('2026-05-01T00:00:00.000Z')
    expect(computeNextRetryAt(20, baseOptions, now)).toBe('2026-05-01T00:01:00.000Z') // capped at 60s
  })
})

describe('classifyRepairableRanges', () => {
  const now = new Date('2026-05-01T00:00:00.000Z')

  it('skips verified ranges entirely', () => {
    const result = classifyRepairableRanges(
      [makeRange({ status: 'verified' })],
      baseOptions,
      now,
    )
    expect(result.eligible).toEqual([])
    expect(result.deferred).toEqual([])
    expect(result.exhausted).toEqual([])
  })

  it('classifies ranges past attempt limit as exhausted', () => {
    const exhausted = makeRange({ attempts: 3 })
    const result = classifyRepairableRanges([exhausted], baseOptions, now)
    expect(result.exhausted).toEqual([exhausted])
    expect(result.eligible).toEqual([])
  })

  it('defers ranges still in their backoff window', () => {
    const deferred = makeRange({
      attempts: 1,
      nextRetryAt: '2026-05-01T00:00:30.000Z',
    })
    const result = classifyRepairableRanges([deferred], baseOptions, now)
    expect(result.deferred).toEqual([deferred])
    expect(result.eligible).toEqual([])
  })

  it('marks ranges past their retry time as eligible', () => {
    const eligible = makeRange({
      attempts: 1,
      nextRetryAt: '2026-04-30T23:59:00.000Z',
    })
    const result = classifyRepairableRanges([eligible], baseOptions, now)
    expect(result.eligible).toEqual([eligible])
    expect(result.deferred).toEqual([])
  })

  it('treats null nextRetryAt as ready immediately', () => {
    const ready = makeRange({ attempts: 1, nextRetryAt: null })
    const result = classifyRepairableRanges([ready], baseOptions, now)
    expect(result.eligible).toEqual([ready])
  })
})

describe('getExhaustedRepairRanges', () => {
  it('returns only failed/suspicious ranges past the attempt limit', () => {
    const ranges = [
      makeRange({ fromBlock: 1, toBlock: 10, status: 'verified', attempts: 5 }),
      makeRange({ fromBlock: 11, toBlock: 20, status: 'failed', attempts: 1 }),
      makeRange({ fromBlock: 21, toBlock: 30, status: 'failed', attempts: 3 }),
      makeRange({ fromBlock: 31, toBlock: 40, status: 'suspicious', attempts: 4 }),
    ]
    expect(getExhaustedRepairRanges(ranges, 3)).toEqual([
      { fromBlock: 21, toBlock: 30 },
      { fromBlock: 31, toBlock: 40 },
    ])
  })

  it('returns an empty list when maxAttempts is non-positive (auto-repair disabled)', () => {
    const ranges = [makeRange({ status: 'failed', attempts: 99 })]
    expect(getExhaustedRepairRanges(ranges, 0)).toEqual([])
  })
})

describe('autoReconcileGaps', () => {
  it('verifies an eligible range and clears it on success', async () => {
    const store = await makeStore()
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109, attempts: 1 }))
    const log = makeRpcLog(100)

    const result = await autoReconcileGaps({
      ...config,
      store,
      provider: makeProvider([log]),
      auditProvider: makeProvider([log]),
      auditProviderName: 'audit',
      options: baseOptions,
    })

    expect(result.attempted).toHaveLength(1)
    expect(result.attempted[0].status).toBe('verified')
    const data = await store.read()
    expect(data.lastReconciledAt).not.toBeNull()
  })

  it('schedules backoff and increments attempts when verification still mismatches', async () => {
    const store = await makeStore()
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109, attempts: 1 }))
    const fixedNow = new Date('2026-05-01T00:00:00.000Z')

    const result = await autoReconcileGaps({
      ...config,
      store,
      provider: makeProvider([makeRpcLog(100)]),
      auditProvider: makeProvider([{ ...makeRpcLog(100), data: '0xff' }]),
      auditProviderName: 'audit',
      options: baseOptions,
      now: () => fixedNow,
    })

    expect(result.attempted).toHaveLength(1)
    expect(result.attempted[0].status).toBe('suspicious')
    const data = await store.read()
    const stored = data.ranges.find((range) => range.fromBlock === 100 && range.toBlock === 109)
    expect(stored?.status).toBe('suspicious')
    expect(stored?.attempts).toBeGreaterThanOrEqual(2)
    // Backoff should be set forward of the fixed clock.
    expect(stored?.nextRetryAt).not.toBeNull()
    expect(new Date(stored!.nextRetryAt!).getTime()).toBeGreaterThan(fixedNow.getTime())
  })

  it('does not retry exhausted ranges and reports the count', async () => {
    const store = await makeStore()
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109, attempts: 99, status: 'failed' }))
    let calls = 0
    const provider: RangeLogProvider = {
      getBlockNumber: async () => 150,
      getLogs: async () => {
        calls += 1
        return [makeRpcLog(100)]
      },
    }

    const result = await autoReconcileGaps({
      ...config,
      store,
      provider,
      auditProvider: provider,
      auditProviderName: 'audit',
      options: baseOptions,
    })

    expect(result.attempted).toEqual([])
    expect(result.exhaustedCount).toBe(1)
    expect(calls).toBe(0)
  })

  it('skips ranges still in their backoff window and reports the count', async () => {
    const store = await makeStore()
    const future = new Date(Date.now() + 60_000).toISOString()
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109, attempts: 1, nextRetryAt: future }))

    const result = await autoReconcileGaps({
      ...config,
      store,
      provider: makeProvider([makeRpcLog(100)]),
      auditProvider: makeProvider([makeRpcLog(100)]),
      auditProviderName: 'audit',
      options: baseOptions,
    })

    expect(result.attempted).toEqual([])
    expect(result.deferredCount).toBe(1)
  })

  it('is a no-op when maxAttempts is 0 (auto-repair disabled)', async () => {
    const store = await makeStore()
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109, attempts: 1, status: 'failed' }))

    const result = await autoReconcileGaps({
      ...config,
      store,
      provider: makeProvider([makeRpcLog(100)]),
      options: { ...baseOptions, maxAttempts: 0 },
    })

    expect(result.attempted).toEqual([])
    expect(result.deferredCount).toBe(0)
    expect(result.exhaustedCount).toBe(0)
  })
})

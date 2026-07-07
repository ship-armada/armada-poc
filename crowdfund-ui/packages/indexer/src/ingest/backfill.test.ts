// ABOUTME: Unit tests for chunked indexer backfill planning and execution.
// ABOUTME: Verifies sequential chunk verification and stop-on-unverified behavior.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileIndexerStore } from '../db/fileStore.js'
import { backfillVerifiedRanges, planBackfillRanges } from './backfill.js'
import type { CursorState } from '../types.js'
import type { RangeLogProvider, RpcLog } from './rpc.js'

const tempDirs: string[] = []

const cursor: CursorState = {
  deployBlock: 100,
  confirmationDepth: 2,
  chainHead: 100,
  confirmedHead: 100,
  ingestedCursor: 99,
  verifiedCursor: 99,
}

const config = {
  chainId: 11155111,
  contractAddress: '0xF681A7c700420e5CA93f77c8988d3eED02767035',
  providerName: 'primary',
}

function makeLog(blockNumber: number, data = '0x'): RpcLog {
  return {
    blockNumber,
    blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionHash: '0x' + (blockNumber + 1).toString(16).padStart(64, '0'),
    index: 0,
    topics: ['0x' + '33'.repeat(32)],
    data,
  }
}

function makeProvider(logsByRange: Map<string, readonly RpcLog[]>, blockNumber = 112): RangeLogProvider {
  return {
    getBlockNumber: async () => blockNumber,
    getLogs: async ({ fromBlock, toBlock }) => logsByRange.get(`${fromBlock}-${toBlock}`) ?? [],
  }
}

async function makeStore(): Promise<FileIndexerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'crowdfund-indexer-backfill-'))
  tempDirs.push(dir)
  return new FileIndexerStore({
    path: join(dir, 'store.json'),
    initialCursor: cursor,
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('chunked backfill', () => {
  it('plans inclusive block ranges', () => {
    expect(planBackfillRanges({ fromBlock: 100, toBlock: 110, maxBlockRange: 5 })).toEqual([
      { fromBlock: 100, toBlock: 104 },
      { fromBlock: 105, toBlock: 109 },
      { fromBlock: 110, toBlock: 110 },
    ])
  })

  it('verifies chunks sequentially and promotes the verified cursor', async () => {
    const store = await makeStore()
    const logs = new Map<string, readonly RpcLog[]>([
      ['100-104', [makeLog(100)]],
      ['105-109', [makeLog(105)]],
      ['110-110', [makeLog(110)]],
    ])

    const result = await backfillVerifiedRanges({
      ...config,
      store,
      provider: makeProvider(logs),
      auditProvider: makeProvider(logs),
      auditProviderName: 'audit',
      maxBlockRange: 5,
    })

    const data = await store.read()
    expect(result.ranges.map((range) => range.status)).toEqual(['verified', 'verified', 'verified'])
    expect(result.stoppedEarly).toBe(false)
    expect(data.cursor.confirmedHead).toBe(110)
    expect(data.cursor.verifiedCursor).toBe(110)
  })

  function makeCountingProvider(logs: Map<string, readonly RpcLog[]>, counter: { calls: number }): RangeLogProvider {
    return {
      getBlockNumber: async () => 112,
      getLogs: async ({ fromBlock, toBlock }) => {
        counter.calls += 1
        return logs.get(`${fromBlock}-${toBlock}`) ?? []
      },
    }
  }

  function seedFailedRange(store: FileIndexerStore, overrides: { attempts: number; nextRetryAt: string | null }) {
    return store.upsertRange({
      fromBlock: 100,
      toBlock: 104,
      status: 'failed',
      provider: 'primary',
      attempts: overrides.attempts,
      logCount: 0,
      digest: null,
      fetchedAt: '2026-05-01T00:00:00.000Z',
      verifiedAt: null,
      lastError: 'RPC timeout',
      nextRetryAt: overrides.nextRetryAt,
    })
  }

  it('defers a failed chunk still inside its backoff window (no RPC, stops early)', async () => {
    const store = await makeStore()
    const now = () => new Date('2026-06-15T12:00:00.000Z')
    await seedFailedRange(store, { attempts: 1, nextRetryAt: '2026-06-15T12:05:00.000Z' })
    const counter = { calls: 0 }
    const provider = makeCountingProvider(new Map(), counter)

    const result = await backfillVerifiedRanges({
      ...config,
      store,
      provider,
      maxBlockRange: 5,
      retryPolicy: { maxAttempts: 6, now },
    })

    expect(counter.calls).toBe(0)
    expect(result.stoppedEarly).toBe(true)
    expect(result.ranges).toHaveLength(0)
    expect((await store.read()).cursor.verifiedCursor).toBe(99)
  })

  it('retries a failed chunk once its backoff window has elapsed', async () => {
    const store = await makeStore()
    const now = () => new Date('2026-06-15T12:00:00.000Z')
    await seedFailedRange(store, { attempts: 1, nextRetryAt: '2026-06-15T11:55:00.000Z' })
    const logs = new Map<string, readonly RpcLog[]>([['100-104', [makeLog(100)]]])
    const counter = { calls: 0 }
    const provider = makeCountingProvider(logs, counter)

    const result = await backfillVerifiedRanges({
      ...config,
      store,
      provider,
      auditProvider: makeCountingProvider(logs, { calls: 0 }),
      auditProviderName: 'audit',
      maxBlockRange: 5,
      retryPolicy: { maxAttempts: 6, now },
    })

    expect(counter.calls).toBeGreaterThan(0)
    expect(result.ranges[0]?.status).toBe('verified')
  })

  it('skips an exhausted chunk under policy but retries it without one (CLI path)', async () => {
    const logs = new Map<string, readonly RpcLog[]>([['100-104', [makeLog(100)]]])

    const polled = await makeStore()
    await seedFailedRange(polled, { attempts: 3, nextRetryAt: null })
    const polledCounter = { calls: 0 }
    const polledResult = await backfillVerifiedRanges({
      ...config,
      store: polled,
      provider: makeCountingProvider(logs, polledCounter),
      maxBlockRange: 5,
      retryPolicy: { maxAttempts: 3 },
    })
    expect(polledCounter.calls).toBe(0)
    expect(polledResult.stoppedEarly).toBe(true)

    const cli = await makeStore()
    await seedFailedRange(cli, { attempts: 3, nextRetryAt: null })
    const cliCounter = { calls: 0 }
    const cliResult = await backfillVerifiedRanges({
      ...config,
      store: cli,
      provider: makeCountingProvider(logs, cliCounter),
      auditProvider: makeCountingProvider(logs, { calls: 0 }),
      auditProviderName: 'audit',
      maxBlockRange: 5,
    })
    expect(cliCounter.calls).toBeGreaterThan(0)
    expect(cliResult.ranges[0]?.status).toBe('verified')
  })

  it('stops when a chunk fails verification', async () => {
    const store = await makeStore()
    const primaryLogs = new Map<string, readonly RpcLog[]>([
      ['100-104', [makeLog(100)]],
      ['105-109', [makeLog(105, '0x01')]],
      ['110-110', [makeLog(110)]],
    ])
    const auditLogs = new Map<string, readonly RpcLog[]>([
      ['100-104', [makeLog(100)]],
      ['105-109', [makeLog(105, '0x02')]],
      ['110-110', [makeLog(110)]],
    ])

    const result = await backfillVerifiedRanges({
      ...config,
      store,
      provider: makeProvider(primaryLogs),
      auditProvider: makeProvider(auditLogs),
      auditProviderName: 'audit',
      maxBlockRange: 5,
    })

    const data = await store.read()
    expect(result.ranges.map((range) => range.status)).toEqual(['verified', 'suspicious'])
    expect(result.stoppedEarly).toBe(true)
    expect(data.cursor.verifiedCursor).toBe(104)
  })
})

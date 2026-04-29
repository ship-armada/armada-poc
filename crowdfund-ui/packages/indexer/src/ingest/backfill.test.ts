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
  overlapWindow: 100,
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

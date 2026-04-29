// ABOUTME: Unit tests for RPC-backed range staging, verification, and repair behavior.
// ABOUTME: Uses fake providers so cursor promotion and gap handling are tested without live RPC.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileIndexerStore } from '../db/fileStore.js'
import { repairRanges, stageRange, verifyRange } from './rpc.js'
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

function makeRpcLog(overrides: Partial<RpcLog> = {}): RpcLog {
  return {
    blockNumber: 100,
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: '0x' + '22'.repeat(32),
    index: 0,
    topics: ['0x' + '33'.repeat(32)],
    data: '0x',
    ...overrides,
  }
}

function makeProvider(logs: readonly RpcLog[], blockNumber = 150): RangeLogProvider {
  return {
    getBlockNumber: async () => blockNumber,
    getLogs: async () => logs,
  }
}

function makeFailingProvider(message: string): RangeLogProvider {
  return {
    getBlockNumber: async () => 150,
    getLogs: async () => {
      throw new Error(message)
    },
  }
}

function makeRange(overrides: Partial<IngestRangeRecord>): IngestRangeRecord {
  return {
    fromBlock: 120,
    toBlock: 129,
    status: 'failed',
    provider: 'primary',
    attempts: 1,
    logCount: 0,
    digest: null,
    fetchedAt: null,
    verifiedAt: null,
    lastError: 'RPC timeout',
    ...overrides,
  }
}

async function makeStore(): Promise<FileIndexerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'crowdfund-indexer-rpc-'))
  tempDirs.push(dir)
  return new FileIndexerStore({
    path: join(dir, 'store.json'),
    initialCursor: cursor,
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('RPC range pipeline', () => {
  it('stages fetched logs and advances the ingested cursor', async () => {
    const store = await makeStore()
    const record = await stageRange({
      ...config,
      store,
      provider: makeProvider([makeRpcLog({ blockNumber: 120 })]),
      range: { fromBlock: 120, toBlock: 129 },
    })

    const data = await store.read()
    expect(record.status).toBe('staged')
    expect(data.cursor.ingestedCursor).toBe(129)
    expect(data.rawLogs).toHaveLength(1)
    expect(data.lastError).toBeNull()
  })

  it('verifies matching primary and audit logs and promotes contiguous cursor', async () => {
    const store = await makeStore()
    const log = makeRpcLog({ blockNumber: 100 })

    const record = await verifyRange({
      ...config,
      store,
      provider: makeProvider([log]),
      auditProvider: makeProvider([log]),
      auditProviderName: 'audit',
      range: { fromBlock: 100, toBlock: 109 },
    })

    const data = await store.read()
    expect(record.status).toBe('verified')
    expect(data.cursor.verifiedCursor).toBe(109)
    expect(data.lastVerifiedAt).not.toBeNull()
  })

  it('marks a range suspicious when audit digest disagrees', async () => {
    const store = await makeStore()

    const record = await verifyRange({
      ...config,
      store,
      provider: makeProvider([makeRpcLog({ data: '0x01' })]),
      auditProvider: makeProvider([makeRpcLog({ data: '0x02' })]),
      auditProviderName: 'audit',
      range: { fromBlock: 100, toBlock: 109 },
    })

    const data = await store.read()
    expect(record.status).toBe('suspicious')
    expect(data.cursor.verifiedCursor).toBe(99)
    expect(data.lastError).toContain('Digest mismatch')
  })

  it('records failed ranges without advancing cursors', async () => {
    const store = await makeStore()

    const record = await stageRange({
      ...config,
      store,
      provider: makeFailingProvider('RPC timeout'),
      range: { fromBlock: 120, toBlock: 129 },
    })

    const data = await store.read()
    expect(record.status).toBe('failed')
    expect(data.cursor.ingestedCursor).toBe(99)
    expect(data.lastError).toBe('RPC timeout')
  })

  it('repairs failed ranges through verification', async () => {
    const store = await makeStore()
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109 }))
    const log = makeRpcLog({ blockNumber: 100 })

    const repaired = await repairRanges({
      ...config,
      store,
      provider: makeProvider([log]),
      auditProvider: makeProvider([log]),
      auditProviderName: 'audit',
    })

    const data = await store.read()
    expect(repaired.map((record) => record.status)).toEqual(['verified'])
    expect(data.cursor.verifiedCursor).toBe(109)
  })
})

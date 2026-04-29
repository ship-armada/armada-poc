// ABOUTME: Unit tests for JSON-file backed indexer persistence.
// ABOUTME: Verifies restart-safe cursor/range storage and deterministic range ordering.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileIndexerStore } from './fileStore.js'
import type { CursorState, IngestRangeRecord } from '../types.js'

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

function makeRange(overrides: Partial<IngestRangeRecord>): IngestRangeRecord {
  return {
    fromBlock: 100,
    toBlock: 109,
    status: 'staged',
    provider: 'primary',
    attempts: 1,
    logCount: 0,
    digest: null,
    fetchedAt: null,
    verifiedAt: null,
    lastError: null,
    ...overrides,
  }
}

async function makeStore(): Promise<FileIndexerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'crowdfund-indexer-'))
  tempDirs.push(dir)
  return new FileIndexerStore({
    path: join(dir, 'store.json'),
    initialCursor: cursor,
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FileIndexerStore', () => {
  it('returns an empty store when no file exists yet', async () => {
    const store = await makeStore()

    await expect(store.read()).resolves.toEqual({
      cursor,
      ranges: [],
      rawLogs: [],
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    })
  })

  it('persists cursor and ranges across store instances', async () => {
    const store = await makeStore()
    const data = await store.upsertRange(makeRange({ fromBlock: 120, toBlock: 129 }))
    const nextStore = new FileIndexerStore({ path: store.filePath, initialCursor: cursor })

    await nextStore.updateCursor({ ...data.cursor, ingestedCursor: 129 })

    const restored = await nextStore.read()
    expect(restored.cursor.ingestedCursor).toBe(129)
    expect(restored.ranges).toEqual([makeRange({ fromBlock: 120, toBlock: 129 })])
  })

  it('upserts ranges by block span and keeps them sorted', async () => {
    const store = await makeStore()
    await store.upsertRange(makeRange({ fromBlock: 120, toBlock: 129, status: 'failed' }))
    await store.upsertRange(makeRange({ fromBlock: 100, toBlock: 109, status: 'verified' }))
    await store.upsertRange(makeRange({ fromBlock: 120, toBlock: 129, status: 'verified' }))

    const restored = await store.read()
    expect(restored.ranges.map((range) => [range.fromBlock, range.toBlock, range.status])).toEqual([
      [100, 109, 'verified'],
      [120, 129, 'verified'],
    ])
  })

  it('upserts raw logs by canonical identity and keeps them sorted', async () => {
    const store = await makeStore()
    const first = {
      chainId: 11155111,
      contractAddress: '0xF681A7c700420e5CA93f77c8988d3eED02767035',
      blockNumber: 120,
      blockHash: '0x' + '11'.repeat(32),
      transactionHash: '0x' + '22'.repeat(32),
      logIndex: 1,
      topics: ['0x' + '33'.repeat(32)],
      data: '0x01',
    }
    const replacement = { ...first, data: '0x02' }
    const earlier = {
      ...first,
      blockNumber: 119,
      blockHash: '0x' + '44'.repeat(32),
      transactionHash: '0x' + '55'.repeat(32),
      logIndex: 0,
    }

    await store.upsertRawLogs([first, earlier, replacement])

    const restored = await store.read()
    expect(restored.rawLogs).toEqual([earlier, replacement])
  })
})

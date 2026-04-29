// ABOUTME: Unit tests for indexer HTTP API route behavior.
// ABOUTME: Exercises health, snapshot, and event delta endpoints against a file-backed test store.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Interface } from 'ethers'
import { createIndexerApi } from './server.js'
import { FileIndexerStore } from '../db/fileStore.js'
import { CROWDFUND_ABI_FRAGMENTS } from '../../../shared/src/lib/constants.js'
import type { CursorState, IndexedRawLog } from '../types.js'

const tempDirs: string[] = []
const iface = new Interface(CROWDFUND_ABI_FRAGMENTS)
const contractAddress = '0xF681A7c700420e5CA93f77c8988d3eED02767035'

const cursor: CursorState = {
  deployBlock: 100,
  confirmationDepth: 12,
  overlapWindow: 100,
  chainHead: 120,
  confirmedHead: 110,
  ingestedCursor: 110,
  verifiedCursor: 110,
}

function makeLog(eventName: string, args: readonly unknown[], blockNumber: number): IndexedRawLog {
  const encoded = iface.encodeEventLog(iface.getEvent(eventName)!, args)
  return {
    chainId: 11155111,
    contractAddress,
    blockNumber,
    blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionHash: '0x' + (blockNumber + 1).toString(16).padStart(64, '0'),
    logIndex: 0,
    topics: encoded.topics,
    data: encoded.data,
  }
}

async function makeStore(): Promise<FileIndexerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'crowdfund-indexer-api-'))
  tempDirs.push(dir)
  const store = new FileIndexerStore({
    path: join(dir, 'store.json'),
    initialCursor: cursor,
  })
  await store.upsertRawLogs([
    makeLog('SeedAdded', ['0x1111111111111111111111111111111111111111'], 100),
    makeLog('Committed', ['0x1111111111111111111111111111111111111111', 0, 1_000_000n], 101),
  ])
  await store.updateCursor(cursor)
  return store
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('indexer API', () => {
  it('serves health and snapshot data', async () => {
    const app = createIndexerApi({
      store: await makeStore(),
      chainId: 11155111,
      contractAddress,
    })
    const server = app.listen(0)
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing test server address')
      const baseUrl = `http://127.0.0.1:${address.port}`

      const health = await fetch(`${baseUrl}/health`).then((res) => res.json()) as Record<string, unknown>
      const snapshot = await fetch(`${baseUrl}/snapshot`).then((res) => res.json()) as { events: unknown[] }
      const delta = await fetch(`${baseUrl}/events?afterBlock=100&afterLogIndex=0`).then((res) => res.json()) as { events: unknown[] }

      expect(health.status).toBe('healthy')
      expect(snapshot.events).toHaveLength(2)
      expect(delta.events).toHaveLength(1)
    } finally {
      server.close()
    }
  })
})

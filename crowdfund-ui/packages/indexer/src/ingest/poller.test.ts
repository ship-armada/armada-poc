// ABOUTME: Unit tests for the supervised indexer polling loop.
// ABOUTME: Verifies retry, timeout, error visibility, and non-overlapping poll cycles.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileIndexerStore } from '../db/fileStore.js'
import { CrowdfundIndexerPoller, createResilientRangeProvider } from './poller.js'
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

function makeLog(blockNumber: number): RpcLog {
  return {
    blockNumber,
    blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionHash: '0x' + (blockNumber + 1).toString(16).padStart(64, '0'),
    index: 0,
    topics: ['0x' + '33'.repeat(32)],
    data: '0x',
  }
}

async function makeStore(): Promise<FileIndexerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'crowdfund-indexer-poller-'))
  tempDirs.push(dir)
  return new FileIndexerStore({
    path: join(dir, 'store.json'),
    initialCursor: cursor,
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createResilientRangeProvider', () => {
  it('retries rate-limited getLogs calls before succeeding', async () => {
    let calls = 0
    const provider: RangeLogProvider = {
      getBlockNumber: async () => 102,
      getLogs: async () => {
        calls += 1
        if (calls === 1) {
          const err = new Error('429 Too Many Requests')
          throw err
        }
        return [makeLog(100)]
      },
    }

    const resilient = createResilientRangeProvider(provider, {
      timeoutMs: 50,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })

    await expect(resilient.getLogs({ address: config.contractAddress, fromBlock: 100, toBlock: 100 })).resolves.toHaveLength(1)
    expect(calls).toBe(2)
  })

  it('times out non-responsive provider calls', async () => {
    const provider: RangeLogProvider = {
      getBlockNumber: async () => 102,
      getLogs: async () => new Promise<readonly RpcLog[]>(() => {}),
    }

    const resilient = createResilientRangeProvider(provider, {
      timeoutMs: 5,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    })

    await expect(resilient.getLogs({ address: config.contractAddress, fromBlock: 100, toBlock: 100 })).rejects.toThrow('RPC timeout')
  })
})

describe('CrowdfundIndexerPoller', () => {
  it('records timeout failures without advancing the verified cursor', async () => {
    const store = await makeStore()
    const provider: RangeLogProvider = {
      getBlockNumber: async () => 102,
      getLogs: async () => new Promise<readonly RpcLog[]>(() => {}),
    }

    const poller = new CrowdfundIndexerPoller({
      ...config,
      store,
      provider,
      maxBlockRange: 5,
      rpcTimeoutMs: 5,
      rpcMaxRetries: 0,
      retryBaseDelayMs: 1,
      pollIntervalMs: 1000,
      errorBackoffMs: 1000,
    })

    const result = await poller.runOnce()
    const data = await store.read()

    expect(result.status).toBe('completed')
    expect(data.cursor.verifiedCursor).toBe(99)
    expect(data.ranges[0]).toMatchObject({ fromBlock: 100, toBlock: 100, status: 'failed' })
    expect(data.lastError).toContain('RPC timeout')
  })

  it('does not run overlapping poll cycles', async () => {
    const store = await makeStore()
    const controls: { releaseBlockNumber?: () => void } = {}
    const provider: RangeLogProvider = {
      getBlockNumber: async () => new Promise<number>((resolve) => {
        controls.releaseBlockNumber = () => resolve(102)
      }),
      getLogs: async ({ fromBlock }) => [makeLog(fromBlock)],
    }

    const poller = new CrowdfundIndexerPoller({
      ...config,
      store,
      provider,
      auditProvider: provider,
      auditProviderName: 'audit',
      maxBlockRange: 5,
      rpcTimeoutMs: 50,
      rpcMaxRetries: 0,
      retryBaseDelayMs: 1,
      pollIntervalMs: 1000,
      errorBackoffMs: 1000,
    })

    const first = poller.runOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await poller.runOnce()
    if (!controls.releaseBlockNumber) throw new Error('provider did not start')
    controls.releaseBlockNumber()
    const firstResult = await first

    expect(second.status).toBe('skipped')
    expect(firstResult.status).toBe('completed')
  })
})

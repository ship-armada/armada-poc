// ABOUTME: Tests for the watcher quick-sync client — the QuickSyncEvents callback wired into the engine (initForWallet arg 4).
// ABOUTME: Covers pagination assembly + every degrade path (no indexer, non-hub chain, V3, non-2xx, network error, malformed page) → empty result (slow-scan fallback).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const hoisted = vi.hoisted(() => ({
  networkConfig: {
    mode: 'sepolia' as const,
    hub: { chainId: 11155111 },
    indexerUrl: 'https://indexer.example' as string | null,
  },
  trackError: vi.fn(),
  track: vi.fn(),
}))

vi.mock('@/config/network', () => ({
  getNetworkConfig: () => hoisted.networkConfig,
}))

vi.mock('@/lib/telemetry', () => ({
  trackError: hoisted.trackError,
  track: hoisted.track,
}))

import { quickSyncEventsClient } from './quickSync'

const V2 = 'V2_PoseidonMerkle' as never
const V3 = 'V3_PoseidonMerkle' as never
const HUB_CHAIN = { type: 0, id: 11155111 } as never

const fetchMock = vi.fn()
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  fetchMock.mockReset()
  hoisted.trackError.mockReset()
  hoisted.track.mockReset()
  hoisted.networkConfig.indexerUrl = 'https://indexer.example'
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

function commitmentEvent(blockNumber: number) {
  return { txid: '0xtx', treeNumber: 0, startPosition: 0, commitments: [], blockNumber }
}
function nullifierEvent(blockNumber: number) {
  return { nullifier: '0xnf', treeNumber: 0, txid: '0xtx', blockNumber }
}
function unshieldEvent(blockNumber: number) {
  return { txid: '0xtx', toAddress: '0xrecipient', amount: '1000', blockNumber }
}

function pageResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('quickSyncEventsClient', () => {
  it('paginates until servedThroughBlock === indexedThrough and assembles all events', async () => {
    fetchMock.mockImplementation((url: string) => {
      const start = Number(new URL(url).searchParams.get('startingBlock'))
      if (start === 0) {
        return Promise.resolve(
          pageResponse({
            commitmentEvents: [commitmentEvent(10)],
            unshieldEvents: [],
            nullifierEvents: [nullifierEvent(10)],
            servedThroughBlock: 100,
            indexedThrough: 250,
          }),
        )
      }
      // start === 101
      return Promise.resolve(
        pageResponse({
          commitmentEvents: [commitmentEvent(200)],
          unshieldEvents: [unshieldEvent(200)],
          nullifierEvents: [],
          servedThroughBlock: 250,
          indexedThrough: 250,
        }),
      )
    })

    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondUrl = fetchMock.mock.calls[1]![0] as string
    expect(new URL(secondUrl).searchParams.get('startingBlock')).toBe('101')
    expect(new URL(secondUrl).pathname).toBe('/v1/quick-sync/11155111')

    expect(result.commitmentEvents).toHaveLength(2)
    expect(result.unshieldEvents).toHaveLength(1)
    expect(result.nullifierEvents).toHaveLength(1)
    expect(hoisted.trackError).not.toHaveBeenCalled()
    expect(hoisted.track).toHaveBeenCalledWith('shielded.quicksync', {
      outcome: 'served',
      pages: 2,
      commitments: 2,
      unshields: 1,
      nullifiers: 1,
      throughBlock: 250,
    })
  })

  it('returns empty (slow-scan fallback) when indexerUrl is null', async () => {
    hoisted.networkConfig.indexerUrl = null
    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 0)
    expect(result).toEqual({ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.track).toHaveBeenCalledWith('shielded.quicksync', { outcome: 'no-indexer' })
  })

  it('returns empty when the requested chain is not the hub', async () => {
    const result = await quickSyncEventsClient(V2, { type: 0, id: 84532 } as never, 0)
    expect(result.commitmentEvents).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns empty for a non-V2 txid version (endpoint serves V2 events only)', async () => {
    const result = await quickSyncEventsClient(V3, HUB_CHAIN, 0)
    expect(result.commitmentEvents).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns empty and logs when a page fetch rejects mid-pagination', async () => {
    fetchMock.mockImplementation((url: string) => {
      const start = Number(new URL(url).searchParams.get('startingBlock'))
      if (start === 0) {
        return Promise.resolve(
          pageResponse({
            commitmentEvents: [commitmentEvent(10)],
            unshieldEvents: [],
            nullifierEvents: [],
            servedThroughBlock: 100,
            indexedThrough: 250,
          }),
        )
      }
      return Promise.reject(new Error('network down'))
    })

    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 0)
    expect(result).toEqual({ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] })
    expect(hoisted.trackError).toHaveBeenCalled()
    expect(hoisted.track).toHaveBeenCalledWith('shielded.quicksync', {
      outcome: 'fell-back',
      reason: 'fetch-error',
    })
  })

  it('returns empty on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 0)
    expect(result.commitmentEvents).toEqual([])
    expect(hoisted.trackError).toHaveBeenCalled()
    expect(hoisted.track).toHaveBeenCalledWith('shielded.quicksync', {
      outcome: 'fell-back',
      reason: 'http-503',
      pages: 0,
    })
  })

  it('returns empty on a malformed page (missing arrays / cursors)', async () => {
    fetchMock.mockResolvedValue(pageResponse({ commitmentEvents: 'not-an-array' }))
    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 0)
    expect(result.commitmentEvents).toEqual([])
    expect(hoisted.trackError).toHaveBeenCalled()
  })

  it('returns empty on a page whose events fail per-event shape validation', async () => {
    fetchMock.mockResolvedValue(
      pageResponse({
        commitmentEvents: [{ txid: '0xtx' /* missing treeNumber/blockNumber */ }],
        unshieldEvents: [],
        nullifierEvents: [],
        servedThroughBlock: 100,
        indexedThrough: 100,
      }),
    )
    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 0)
    expect(result.commitmentEvents).toEqual([])
    expect(hoisted.trackError).toHaveBeenCalled()
  })

  it('breaks defensively when the cursor does not advance (server bug)', async () => {
    // servedThroughBlock stays below the request cursor forever — must not loop.
    fetchMock.mockResolvedValue(
      pageResponse({
        commitmentEvents: [],
        unshieldEvents: [],
        nullifierEvents: [],
        servedThroughBlock: 5,
        indexedThrough: 999,
      }),
    )
    const result = await quickSyncEventsClient(V2, HUB_CHAIN, 50)
    expect(result.commitmentEvents).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ABOUTME: Unit tests for RPC provider creation and log fetching.
// ABOUTME: Tests ordered fallback across multiple RPC endpoints.

import { describe, it, expect, vi } from 'vitest'
import { createProvider, FallbackJsonRpcProvider, fetchLogs } from './rpc.js'
import { JsonRpcProvider } from 'ethers'

/** Minimal provider stand-in for fetchLogs (only getBlockNumber + getLogs used). */
function makeFakeProvider(opts: {
  head: number
  getLogs: (args: { fromBlock: number; toBlock: number }) => Promise<unknown[]>
}) {
  return {
    getBlockNumber: async () => opts.head,
    getLogs: async (args: { address: string; fromBlock: number; toBlock: number }) =>
      opts.getLogs(args),
  } as unknown as JsonRpcProvider
}

function mkLog(blockNumber: number, index: number) {
  return {
    blockNumber,
    transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    index,
    topics: ['0xtopic'],
    data: '0x',
  }
}

describe('createProvider', () => {
  it('creates a provider from a single URL', () => {
    const provider = createProvider(['http://localhost:8545'])
    expect(provider).toBeDefined()
  })

  it('throws for empty URL list', () => {
    expect(() => createProvider([])).toThrow('No RPC URLs provided')
  })

  it('returns FallbackJsonRpcProvider for multiple URLs', () => {
    const provider = createProvider(['http://localhost:8545', 'http://localhost:8546'])
    expect(provider).toBeInstanceOf(FallbackJsonRpcProvider)
  })

  it('returns plain JsonRpcProvider for single URL', () => {
    const provider = createProvider(['http://localhost:8545'])
    // Should be a plain JsonRpcProvider, not FallbackJsonRpcProvider
    expect(provider).toBeInstanceOf(JsonRpcProvider)
    expect(provider).not.toBeInstanceOf(FallbackJsonRpcProvider)
  })
})

describe('FallbackJsonRpcProvider', () => {
  // Test _send directly to avoid ethers' request/response ID matching layer

  const testPayload = { id: 1, method: 'eth_chainId', jsonrpc: '2.0' as const, params: [] }

  it('falls back to next URL when first provider fails with transport error', async () => {
    const provider = new FallbackJsonRpcProvider([
      'http://url1:8545',
      'http://url2:8545',
    ])

    vi.spyOn(provider._providers[0], '_send').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    )
    vi.spyOn(provider._providers[1], '_send').mockResolvedValue(
      [{ id: 1, result: '0x1' }],
    )

    const result = await provider._send(testPayload)
    expect(result).toEqual([{ id: 1, result: '0x1' }])
    expect(provider._providers[0]._send).toHaveBeenCalledTimes(1)
    expect(provider._providers[1]._send).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on RPC-level errors (valid response with error)', async () => {
    const provider = new FallbackJsonRpcProvider([
      'http://url1:8545',
      'http://url2:8545',
    ])

    // RPC error response — valid transport, but execution failed.
    // _send returns successfully (no throw) with an error field in the result.
    // Cast: ethers' JsonRpcResult type only describes the success shape, but
    // providers return a union with JsonRpcError at runtime.
    vi.spyOn(provider._providers[0], '_send').mockResolvedValue(
      [{ id: 1, error: { code: -32000, message: 'execution reverted' } }] as unknown as Awaited<
        ReturnType<typeof provider._providers[0]['_send']>
      >,
    )
    vi.spyOn(provider._providers[1], '_send')

    const result = await provider._send(testPayload)
    // RPC errors are returned as valid results — no fallback triggered
    expect(result).toEqual([{ id: 1, error: { code: -32000, message: 'execution reverted' } }])
    expect(provider._providers[1]._send).not.toHaveBeenCalled()
  })

  it('throws when all URLs are exhausted', async () => {
    const provider = new FallbackJsonRpcProvider([
      'http://url1:8545',
      'http://url2:8545',
    ])

    vi.spyOn(provider._providers[0], '_send').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    )
    vi.spyOn(provider._providers[1], '_send').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    )

    await expect(provider._send(testPayload)).rejects.toThrow('connect ECONNREFUSED')
    expect(provider._providers[0]._send).toHaveBeenCalledTimes(1)
    expect(provider._providers[1]._send).toHaveBeenCalledTimes(1)
  })
})

describe('fetchLogs', () => {
  it('chunks the range and reports resolvedTo + per-chunk progress', async () => {
    const calls: Array<{ fromBlock: number; toBlock: number }> = []
    const provider = makeFakeProvider({
      head: 25,
      getLogs: async ({ fromBlock, toBlock }) => {
        calls.push({ fromBlock, toBlock })
        return fromBlock === 1 ? [mkLog(5, 0)] : []
      },
    })
    const chunks: number[] = []
    const result = await fetchLogs(provider, '0xabc', 1, 'latest', {
      maxBlockRange: 10,
      onChunk: ({ scannedTo }) => chunks.push(scannedTo),
    })
    // 1-10, 11-20, 21-25 → three chunks.
    expect(calls).toEqual([
      { fromBlock: 1, toBlock: 10 },
      { fromBlock: 11, toBlock: 20 },
      { fromBlock: 21, toBlock: 25 },
    ])
    expect(chunks).toEqual([10, 20, 25])
    expect(result.resolvedTo).toBe(25)
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0].blockNumber).toBe(5)
  })

  it('returns empty + resolvedTo when fromBlock is past the head', async () => {
    const provider = makeFakeProvider({ head: 5, getLogs: async () => [] })
    const result = await fetchLogs(provider, '0xabc', 10, 'latest', { maxBlockRange: 10 })
    expect(result).toEqual({ logs: [], resolvedTo: 5 })
  })

  it('halves the range and retries on a block-range-too-large error', async () => {
    const widths: number[] = []
    let failedOnce = false
    const provider = makeFakeProvider({
      head: 10,
      getLogs: async ({ fromBlock, toBlock }) => {
        widths.push(toBlock - fromBlock + 1)
        if (!failedOnce && toBlock - fromBlock + 1 > 5) {
          failedOnce = true
          throw new Error('query returned more than 10000 results, reduce your block range')
        }
        return []
      },
    })
    const result = await fetchLogs(provider, '0xabc', 1, 'latest', { maxBlockRange: 10 })
    // First attempt width 10 fails → halves to 5, then proceeds.
    expect(widths[0]).toBe(10)
    expect(widths.slice(1).every((w) => w <= 5)).toBe(true)
    expect(result.resolvedTo).toBe(10)
  })
})

// getBlockTimestamp requires a live provider, so it is tested via integration
// tests with Anvil rather than unit tests.

// ABOUTME: Unit tests for RPC provider creation and log fetching.
// ABOUTME: Tests ordered fallback across multiple RPC endpoints.

import { describe, it, expect, vi } from 'vitest'
import { createProvider, FallbackJsonRpcProvider } from './rpc.js'
import { JsonRpcProvider } from 'ethers'

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

// fetchLogs and getBlockTimestamp require a live provider, so they are tested
// via integration tests with Anvil rather than unit tests.

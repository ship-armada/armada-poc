// ABOUTME: Tests for createProvider / FallbackJsonRpcProvider (P1-18) — single vs multi-URL construction + the 15s fetch-timeout bound that keeps failover fast.

import { describe, it, expect } from 'vitest'
import { JsonRpcProvider } from 'ethers'
import { createProvider, FallbackJsonRpcProvider } from './rpc'

describe('createProvider', () => {
  it('returns a plain JsonRpcProvider for a single URL', () => {
    const p = createProvider(['http://localhost:8545'])
    expect(p).toBeInstanceOf(JsonRpcProvider)
    expect(p).not.toBeInstanceOf(FallbackJsonRpcProvider)
  })

  it('returns a FallbackJsonRpcProvider with one internal provider per URL for multiple URLs', () => {
    const p = createProvider(['http://a.test', 'http://b.test', 'http://c.test'])
    expect(p).toBeInstanceOf(FallbackJsonRpcProvider)
    expect((p as FallbackJsonRpcProvider)._providers).toHaveLength(3)
  })

  it('bounds the fetch timeout at 15s so a black-holed URL fails over fast, not after ethers default ~300s', () => {
    const single = createProvider(['http://localhost:8545'])
    expect(single._getConnection().timeout).toBe(15_000)

    const multi = createProvider(['http://a.test', 'http://b.test'])
    for (const inner of (multi as FallbackJsonRpcProvider)._providers) {
      expect(inner._getConnection().timeout).toBe(15_000)
    }
  })

  it('throws on an empty URL list', () => {
    expect(() => createProvider([])).toThrow()
  })
})

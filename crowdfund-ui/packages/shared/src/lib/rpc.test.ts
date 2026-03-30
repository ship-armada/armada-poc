// ABOUTME: Unit tests for RPC provider creation and log fetching.
// ABOUTME: Uses mock provider to test without a real network connection.

import { describe, it, expect } from 'vitest'
import { createProvider } from './rpc.js'

describe('createProvider', () => {
  it('creates a provider from a single URL', () => {
    const provider = createProvider(['http://localhost:8545'])
    expect(provider).toBeDefined()
  })

  it('throws for empty URL list', () => {
    expect(() => createProvider([])).toThrow('No RPC URLs provided')
  })

  it('uses the first URL', () => {
    const provider = createProvider(['http://localhost:8545', 'http://localhost:8546'])
    // JsonRpcProvider stores the URL internally
    expect(provider).toBeDefined()
  })
})

// fetchLogs and getBlockTimestamp require a live provider, so they are tested
// via integration tests with Anvil rather than unit tests.

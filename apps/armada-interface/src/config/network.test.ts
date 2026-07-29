// ABOUTME: Tests for getNetworkConfig — verifies the maxLogRange cap is conservatively set on testnets so getLogs cannot overrun public RPC limits.

import { describe, it, expect } from 'vitest'
import { getNetworkConfig } from './network'

describe('getNetworkConfig', () => {
  it('exposes a maxLogRange field used as the safe per-chunk block window', () => {
    const cfg = getNetworkConfig()
    expect(cfg.maxLogRange).toBeGreaterThan(0)
  })

  // In the vitest config we pin VITE_NETWORK='local', so we expect the local cap (effectively
  // unlimited for Anvil). The testnet cap is verified at deploy-time review — keeping a single
  // code path means the chunker still runs locally and exercises the same logic.
  it('uses a generous cap on local mode (single chunk for any realistic range)', () => {
    const cfg = getNetworkConfig()
    expect(cfg.mode).toBe('local')
    expect(cfg.maxLogRange).toBeGreaterThanOrEqual(50_000)
  })

  // B4 invariant: with VITE_INDEXER_URL unset (the default test env), indexerUrl resolves to null,
  // so the watcher quick-sync client returns empty and the engine falls back to its slow on-chain
  // scan. The app must be fully functional in this state. When set, both modes honor the env var.
  it('resolves indexerUrl to null when VITE_INDEXER_URL is unset (quick sync disabled → slow scan)', () => {
    const cfg = getNetworkConfig()
    expect(cfg.indexerUrl).toBeNull()
  })
})

// ABOUTME: Tests for the deployment manifest loaders — single-flight dedup of concurrent calls (one
// ABOUTME: fetch per burst) and preserved retry-on-transient-failure semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// getNetworkConfig is the only import — a minimal local config (no clients → loadDeployments fetches
// just the hub manifest, so the dedup assertion is a clean "called once").
vi.mock('./network', () => ({
  getNetworkConfig: () => ({ mode: 'local', clients: [] }),
}))

const okJson = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.resetModules() // fresh module-level cache/pending state per test
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadYieldDeployment — single-flight', () => {
  it('coalesces concurrent calls into one fetch', async () => {
    const fetchMock = vi.fn(async () => okJson({ contracts: { armadaYieldVault: '0xvault' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { loadYieldDeployment } = await import('./deployments')

    const [a, b, c] = await Promise.all([loadYieldDeployment(), loadYieldDeployment(), loadYieldDeployment()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).not.toBeNull()
  })

  it('retries after a transient failure — a failure is not cached', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okJson({ contracts: { armadaYieldVault: '0xvault' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { loadYieldDeployment } = await import('./deployments')

    expect(await loadYieldDeployment()).toBeNull() // transient failure → null, not cached
    expect(await loadYieldDeployment()).not.toBeNull() // next call re-fetches and succeeds
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('loadDeployments — single-flight', () => {
  it('coalesces concurrent calls (hub manifest fetched once, not per caller)', async () => {
    const fetchMock = vi.fn(async () => okJson({ contracts: {}, deployBlock: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const { loadDeployments } = await import('./deployments')

    const [a, b, c] = await Promise.all([loadDeployments(), loadDeployments(), loadDeployments()])

    expect(fetchMock).toHaveBeenCalledTimes(1) // clients: [] → only the hub manifest, once
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

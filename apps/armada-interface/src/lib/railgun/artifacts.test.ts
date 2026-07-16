// ABOUTME: Tests for preloadArtifactsFromOrigin (P0-12) — the self-hosted artifact preload gate.
// ABOUTME: available → overrideArtifact per variant; unavailable / per-variant failure → silent no-op (SDK IPFS fallback covers it).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const overrideArtifactMock = vi.hoisted(() => vi.fn())
vi.mock('@railgun-community/wallet', () => ({
  overrideArtifact: overrideArtifactMock,
  ArtifactStore: class {},
}))

import { preloadArtifactsFromOrigin } from './artifacts'

const fetchMock = vi.fn()
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  fetchMock.mockReset()
  overrideArtifactMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

function binaryResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
}
function jsonResponse(): Response {
  return new Response(JSON.stringify({ vk: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('preloadArtifactsFromOrigin', () => {
  it('overrides each preload variant when artifacts are served at the origin', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }))
      if (String(url).endsWith('vkey.json')) return Promise.resolve(jsonResponse())
      return Promise.resolve(binaryResponse())
    })

    await preloadArtifactsFromOrigin()

    expect(overrideArtifactMock).toHaveBeenCalledTimes(3)
    expect(overrideArtifactMock.mock.calls.map(c => c[0])).toEqual(['1x2', '2x2', '2x3'])
  })

  it('is a silent no-op when artifacts are not served (HEAD 404) — SDK IPFS fallback covers it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))

    await expect(preloadArtifactsFromOrigin()).resolves.toBeUndefined()
    expect(overrideArtifactMock).not.toHaveBeenCalled()
  })

  it('does not abort the other variants (or throw) when one variant fetch fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }))
      if (String(url).includes('/02x02/')) return Promise.resolve(new Response(null, { status: 500 }))
      if (String(url).endsWith('vkey.json')) return Promise.resolve(jsonResponse())
      return Promise.resolve(binaryResponse())
    })

    await expect(preloadArtifactsFromOrigin()).resolves.toBeUndefined()
    // 1x2 and 2x3 succeed; 2x2 fails → 2 overrides, no throw.
    expect(overrideArtifactMock).toHaveBeenCalledTimes(2)
    expect(overrideArtifactMock.mock.calls.map(c => c[0])).toEqual(['1x2', '2x3'])
  })
})

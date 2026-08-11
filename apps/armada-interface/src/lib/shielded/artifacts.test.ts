// ABOUTME: Tests for preloadArtifactsFromOrigin (P0-12) — the self-hosted artifact preload gate.
// ABOUTME: available → registers each variant with our ArtifactGetter; unavailable / per-variant failure → silent no-op.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Spy on the getter registration while keeping the real armadaVariantKey (the test asserts the
// padded NNxMM keys the getter actually looks up).
const setArmadaArtifactMock = vi.hoisted(() => vi.fn())
vi.mock('./artifactGetter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./artifactGetter')>()
  return { ...actual, setArmadaArtifact: setArmadaArtifactMock }
})

import { preloadArtifactsFromOrigin } from './artifacts'

const fetchMock = vi.fn()
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  fetchMock.mockReset()
  setArmadaArtifactMock.mockReset()
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
  it('registers each preload variant with the getter when artifacts are served at the origin', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }))
      if (String(url).endsWith('vkey.json')) return Promise.resolve(jsonResponse())
      return Promise.resolve(binaryResponse())
    })

    await preloadArtifactsFromOrigin()

    expect(setArmadaArtifactMock).toHaveBeenCalledTimes(4)
    // Padded NNxMM keys — the format the getter looks up.
    expect(setArmadaArtifactMock.mock.calls.map(c => c[0])).toEqual(['01x02', '01x03', '02x02', '02x03'])
  })

  it('is a silent no-op when artifacts are not served (HEAD 404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))

    await expect(preloadArtifactsFromOrigin()).resolves.toBeUndefined()
    expect(setArmadaArtifactMock).not.toHaveBeenCalled()
  })

  it('does not abort the other variants (or throw) when one variant fetch fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }))
      if (String(url).includes('/02x02/')) return Promise.resolve(new Response(null, { status: 500 }))
      if (String(url).endsWith('vkey.json')) return Promise.resolve(jsonResponse())
      return Promise.resolve(binaryResponse())
    })

    await expect(preloadArtifactsFromOrigin()).resolves.toBeUndefined()
    // 1x2, 1x3 and 2x3 succeed; 2x2 fails → 3 registrations, no throw.
    expect(setArmadaArtifactMock).toHaveBeenCalledTimes(3)
    expect(setArmadaArtifactMock.mock.calls.map(c => c[0])).toEqual(['01x02', '01x03', '02x03'])
  })
})

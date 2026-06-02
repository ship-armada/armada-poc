// ABOUTME: Tests for pollRelayStatusOnce — the adapter that wraps the relayer /status endpoint for the generic poll() loop.
// ABOUTME: Asserts pending → null (loop keeps waiting), confirmed/failed → terminal value (loop returns done), and signal propagation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { RELAYER_ENDPOINTS, relayerEndpoint } from '@/config/relayer'
import { pollRelayStatusOnce } from './poller'

const fetchMock = vi.fn()
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

const TX_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('pollRelayStatusOnce', () => {
  it('returns null while the relayer reports pending so the poll loop keeps waiting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'pending' }))

    const result = await pollRelayStatusOnce(TX_HASH, new AbortController().signal)

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string]
    // Compute the expected URL via the same helper production code uses — a dev .env.local can
    // override VITE_RELAYER_URL, so hardcoding localhost would falsely fail in that environment.
    expect(url).toBe(`${relayerEndpoint(RELAYER_ENDPOINTS.status)}/${TX_HASH}`)
  })

  it('returns the StatusResponse verbatim once the relayer reports confirmed', async () => {
    const confirmed = { status: 'confirmed', blockNumber: 12_345 }
    fetchMock.mockResolvedValueOnce(jsonResponse(confirmed))

    const result = await pollRelayStatusOnce(TX_HASH, new AbortController().signal)

    expect(result).toEqual(confirmed)
  })

  it('returns the StatusResponse with the error message when the relayer reports failed', async () => {
    // Caller (handler) switches on `status` and writes markFailed when it sees `failed`. The
    // adapter returns rather than throws so the generic poll() loop terminates `done` instead of
    // burning retries on a permanently-failed tx.
    const failed = { status: 'failed', error: 'execution reverted' }
    fetchMock.mockResolvedValueOnce(jsonResponse(failed))

    const result = await pollRelayStatusOnce(TX_HASH, new AbortController().signal)

    expect(result).toEqual(failed)
  })

  it('propagates the caller-supplied AbortSignal to the underlying fetch', async () => {
    const ctrl = new AbortController()
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'pending' }))

    await pollRelayStatusOnce(TX_HASH, ctrl.signal)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(ctrl.signal)
  })

  it('throws a RelayerError on non-2xx, surfacing the poll loop\'s backoff path', async () => {
    // A 5xx from /status is treated as a transient relayer hiccup — the poll loop catches the
    // throw, increments errorStreak, and retries with exponential backoff. The adapter MUST throw
    // (rather than returning null) so the loop's error path engages instead of silently spinning.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'upstream offline' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      pollRelayStatusOnce(TX_HASH, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'RelayerError', httpStatus: 502 })
  })
})

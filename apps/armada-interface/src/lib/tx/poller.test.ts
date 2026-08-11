// ABOUTME: Tests for pollRelayStatusOnce — the adapter that wraps the relayer /status endpoint for the generic poll() loop.
// ABOUTME: Asserts pending → null (loop keeps waiting), confirmed/failed → terminal value (loop returns done), and signal propagation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { RELAYER_ENDPOINTS, relayerEndpoint } from '@/config/relayer'

// Mock the receipt helper so the 404-fallback path doesn't touch wagmi/RPC. Keep the rest of the
// module (asTxError / extractTxError) real so the revert-classification path works.
const receiptMock = vi.hoisted(() => ({ waitForReceiptOrFail: vi.fn() }))
vi.mock('./receipt', async (importActual) => {
  const actual = await importActual<typeof import('./receipt')>()
  return { ...actual, waitForReceiptOrFail: receiptMock.waitForReceiptOrFail }
})

import { poll, pollBudgetMs, pollRelayStatusOnce } from './poller'
import { asTxError } from './receipt'
import { lifecycleFor } from './lifecycles'
import { beginHiddenCredit, markHidden, markVisible, __resetHiddenClock } from './hiddenClock'
import type { TxRecord } from './types'

const fetchMock = vi.fn()
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  fetchMock.mockReset()
  receiptMock.waitForReceiptOrFail.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: 'unknown tx' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

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
    // P0-11: pollStatus now wraps the signal via fetchWithTimeout (caller ∪ timeout), so the fetch
    // receives a COMBINED signal rather than the caller's identity — assert the caller's abort
    // still drives it instead.
    const ctrl = new AbortController()
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'pending' }))

    await pollRelayStatusOnce(TX_HASH, ctrl.signal)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal!.aborted).toBe(false)
    ctrl.abort()
    expect(init.signal!.aborted).toBe(true)
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

  it('on a 404 (relayer forgot the tx), falls back to the RPC receipt → confirmed (P1-25)', async () => {
    fetchMock.mockResolvedValueOnce(notFoundResponse())
    receiptMock.waitForReceiptOrFail.mockResolvedValueOnce({ status: 'success' })

    const result = await pollRelayStatusOnce(TX_HASH, new AbortController().signal, 31337)

    expect(result).toEqual({ status: 'confirmed' })
    expect(receiptMock.waitForReceiptOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ hash: TX_HASH, chainId: 31337 }),
    )
  })

  it('on a 404 where the receipt reverted, maps to a failed StatusResponse (P1-25)', async () => {
    fetchMock.mockResolvedValueOnce(notFoundResponse())
    receiptMock.waitForReceiptOrFail.mockRejectedValueOnce(
      asTxError({ code: 'TX_REVERTED', message: 'reverted on chain' }),
    )

    const result = await pollRelayStatusOnce(TX_HASH, new AbortController().signal, 31337)

    expect(result).toEqual({ status: 'failed', error: 'reverted on chain' })
  })

  it('does NOT fall back on a 5xx — rethrows so the poll loop backs off', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      pollRelayStatusOnce(TX_HASH, new AbortController().signal, 31337),
    ).rejects.toMatchObject({ httpStatus: 503 })
    expect(receiptMock.waitForReceiptOrFail).not.toHaveBeenCalled()
  })
})

describe('pollBudgetMs (P1-25)', () => {
  function shieldRecord(createdMsAgo: number): TxRecord {
    return {
      id: 'b',
      kind: 'shield',
      executionState: 'waiting',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 4,
      createdAt: Date.now() - createdMsAgo,
      updatedAt: Date.now(),
      meta: { amount: 1n, feeCacheId: 'c', fromChainId: 31337 },
      artifacts: { sourceTxHash: '0xfeed' },
      walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
    } as TxRecord
  }

  const SHORT_CAP = lifecycleFor('shield').maxDurationMs // 10 min

  it('returns the remaining budget for a fresh record (≈ the lifecycle cap)', () => {
    const ms = pollBudgetMs(shieldRecord(0))
    expect(ms).toBeGreaterThan(SHORT_CAP - 5_000)
    expect(ms).toBeLessThanOrEqual(SHORT_CAP)
  })

  it('floors at 10s when the record is near or past its budget (not the 30-min default)', () => {
    // 9m55s elapsed → ~5s left → floored to 10s.
    expect(pollBudgetMs(shieldRecord(SHORT_CAP - 5_000))).toBe(10_000)
    // Already over the cap → still floored to 10s, never negative, never the 30-min default.
    expect(pollBudgetMs(shieldRecord(SHORT_CAP + 60_000))).toBe(10_000)
  })

  it('credits tab-hidden time back to the budget (T-M5/S-M6)', () => {
    __resetHiddenClock()
    const rec = shieldRecord(SHORT_CAP - 30_000) // ~30s left without any credit
    const created = rec.createdAt
    beginHiddenCredit(rec.id, created)
    markHidden(created + 1_000)
    markVisible(created + 1_000 + 120_000) // 2 min hidden during the record's life
    // ~30s base + 2 min credit ≈ 2.5 min — far above both the floor and the un-credited remaining.
    expect(pollBudgetMs(rec)).toBeGreaterThan(2 * 60_000)
    __resetHiddenClock()
  })
})

describe('poll loop — final check before timeout (T-M5)', () => {
  it('does one last pollOnce after the budget elapses so a just-landed result isn\'t a false timeout', async () => {
    // The result lands on the 2nd tick, which happens AFTER timeoutMs has elapsed (the delay floor
    // is 500ms; timeoutMs is 5ms). Old behaviour checked the clock before polling and returned
    // `timeout` without the 2nd poll — a delivery that landed during the (throttled) interval was
    // reported as POLL_TIMEOUT. The final-check fix catches it.
    let calls = 0
    const result = await poll<string>(
      async () => {
        calls += 1
        return calls >= 2 ? 'landed' : null
      },
      { intervalMs: 20, jitter: 0, timeoutMs: 5 },
    )
    expect(result.status).toBe('done')
    expect(result.value).toBe('landed')
    expect(calls).toBe(2)
  })
})

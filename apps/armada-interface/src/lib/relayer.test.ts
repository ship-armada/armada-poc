// ABOUTME: Tests for userFeeForKind + cctpMaxFeeForKind — the pure fee-resolution helpers consumed by modals (display) and xchain handlers (CCTP maxFee bound).
// ABOUTME: Also tests the submitRelay HTTP client — success path, RelayerError code/message decode, AbortSignal propagation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { RELAYER_ENDPOINTS, relayerEndpoint } from '@/config/relayer'
import {
  userFeeForKind,
  cctpMaxFeeForKind,
  submitRelay,
  RelayerError,
  type FeeSchedule,
  type RelayRequest,
  type RelayResponse,
} from './relayer'

function quoteWith(overrides: Partial<FeeSchedule['fees']> = {}): FeeSchedule {
  return {
    cacheId: 'test-cache',
    expiresAt: Date.now() + 60_000,
    chainId: 31337,
    broadcasterRailgunAddress: '0zk1test',
    fees: {
      transfer: '0',
      unshield: '0',
      crossContract: '0',
      crossChainShield: '0',
      crossChainUnshield: '0',
      ...overrides,
    },
  }
}

const ONE_USDC = 1_000_000n // 6 decimals
const HUNDRED_USDC = 100n * ONE_USDC

describe('userFeeForKind', () => {
  it.each([
    ['shield'],
    ['transfer-shielded'],
    ['yield-deposit'],
    ['yield-withdraw'],
  ] as const)('returns 0n for %s (handler still user-submitted; migrates in A4)', (kind) => {
    expect(userFeeForKind(kind, HUNDRED_USDC)).toBe(0n)
  })

  describe('unshield-local — relayer-mediated (A3+)', () => {
    it('returns 0n when no quote is provided (cold-load before useFees resolves)', () => {
      // WHY: the modal renders fee summaries before the first /fees response lands. Returning 0n
      // here lets the UI show "Loading…" copy via the modal's `isFeeRefreshing` flag without
      // tripping a `NaN`/`undefined` render.
      expect(userFeeForKind('unshield-local', HUNDRED_USDC)).toBe(0n)
    })

    it('returns the quote\'s unshield fee (raw USDC) regardless of amount', () => {
      // WHY: pin the contract that A3's unshield-local fee is a flat per-op USDC amount sourced
      // verbatim from the relayer's advertised quote, NOT proportional to the unshield amount.
      // The relayer's pre-submit verifier checks the proof embeds this EXACT value.
      const quote = quoteWith({ unshield: '50000' }) // 0.05 USDC raw
      expect(userFeeForKind('unshield-local', HUNDRED_USDC, quote)).toBe(50_000n)
      expect(userFeeForKind('unshield-local', ONE_USDC, quote)).toBe(50_000n)
    })

    it('coerces the quote\'s string fee back to bigint (JSON-on-the-wire shape)', () => {
      // WHY: /fees ships fees as string-encoded bigints because JSON can't carry bigint natively.
      // A regression that compared the raw string to a bigint or that dropped the BigInt()
      // coercion would surface as a runtime TypeError (or worse, a silent string fee that the
      // SDK rejects). Pin the coercion.
      const quote = quoteWith({ unshield: '999999' })
      const fee = userFeeForKind('unshield-local', HUNDRED_USDC, quote)
      expect(typeof fee).toBe('bigint')
      expect(fee).toBe(999_999n)
    })

    it('returns 0n on a null quote (defensive; matches the no-quote case)', () => {
      // WHY: `useFees()` can return `quote: null` between refresh cycles; passing through null is
      // semantically identical to "no quote available." Callers shouldn't have to guard
      // independently.
      expect(userFeeForKind('unshield-local', HUNDRED_USDC, null)).toBe(0n)
    })
  })

  it('returns CCTP fast-fee (2 bps of amount) for shield-xchain', () => {
    // 2 bps of 100 USDC = 0.02 USDC = 20_000 raw
    expect(userFeeForKind('shield-xchain', HUNDRED_USDC)).toBe(20_000n)
  })

  it('returns CCTP fast-fee (2 bps of amount) for unshield-xchain', () => {
    expect(userFeeForKind('unshield-xchain', HUNDRED_USDC)).toBe(20_000n)
  })

  it('rounds toward zero for small amounts (bigint integer division)', () => {
    // 2 bps of 1 USDC = 200 raw → no rounding issue here
    expect(userFeeForKind('shield-xchain', ONE_USDC)).toBe(200n)
    // 2 bps of 4999 raw = 9999 / 10000 = 0 (rounds down)
    expect(userFeeForKind('shield-xchain', 4_999n)).toBe(0n)
    // 2 bps of 5000 raw = 10000 / 10000 = 1
    expect(userFeeForKind('shield-xchain', 5_000n)).toBe(1n)
  })

  it('returns 0n when amount is 0n for cctp kinds (no rejection, just nothing to fee)', () => {
    expect(userFeeForKind('shield-xchain', 0n)).toBe(0n)
    expect(userFeeForKind('unshield-xchain', 0n)).toBe(0n)
  })

  it('scales linearly with amount for cctp kinds', () => {
    const big = HUNDRED_USDC * 10_000n // 1M USDC
    expect(userFeeForKind('shield-xchain', big)).toBe(big * 2n / 10_000n)
  })
})

describe('cctpMaxFeeForKind', () => {
  it('is 2× userFeeForKind so Iris feeExecuted has headroom against the on-chain bound', () => {
    // The contract enforces feeExecuted <= maxFee. We pass 2× the realistic estimate so the
    // actual Iris-set fee (1–1.3 bps depending on chain) never trips the bound.
    expect(cctpMaxFeeForKind('shield-xchain', HUNDRED_USDC)).toBe(40_000n)
    expect(cctpMaxFeeForKind('unshield-xchain', HUNDRED_USDC)).toBe(40_000n)
  })

  it('is 0n for non-CCTP kinds (defensive; these kinds never call CCTP)', () => {
    expect(cctpMaxFeeForKind('shield', HUNDRED_USDC)).toBe(0n)
    expect(cctpMaxFeeForKind('unshield-local', HUNDRED_USDC)).toBe(0n)
  })
})

describe('submitRelay', () => {
  const fetchMock = vi.fn()
  const ORIGINAL_FETCH = globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  const validRequest: RelayRequest = {
    chainId: 31337,
    to: '0x1111111111111111111111111111111111111111',
    data: '0xabcdef',
    feesCacheId: 'fee-123-1',
  }

  it('POSTs the request as JSON to /relay and returns the parsed RelayResponse', async () => {
    const expected: RelayResponse = {
      txHash: '0xdeadbeef0000000000000000000000000000000000000000000000000000beef',
      status: 'pending',
    }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(expected), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const result = await submitRelay(validRequest)

    expect(result).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // Compute the expected URL via the same helper production code uses — a dev .env.local can
    // override VITE_RELAYER_URL, so hardcoding localhost would falsely fail in that environment.
    expect(url).toBe(relayerEndpoint(RELAYER_ENDPOINTS.relay))
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(validRequest)
    // Header object is unioned; spot-check Content-Type without depending on object shape.
    expect(JSON.stringify(init.headers)).toContain('application/json')
  })

  it('throws a RelayerError carrying the typed code + server message on a 402 FEE_EXPIRED', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Fee quote has expired', code: 'FEE_EXPIRED' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(submitRelay(validRequest)).rejects.toMatchObject({
      name: 'RelayerError',
      code: 'FEE_EXPIRED',
      httpStatus: 402,
      message: 'Fee quote has expired',
    })
  })

  it('falls back to the status-code-derived error code when the body omits `code`', async () => {
    // 409 Conflict — the relayer maps this to DUPLICATE_TX (see config/relayer.ts).
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Already submitted' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const err = await submitRelay(validRequest).catch((e) => e)
    expect(err).toBeInstanceOf(RelayerError)
    expect(err.code).toBe('DUPLICATE_TX')
    expect(err.httpStatus).toBe(409)
    expect(err.message).toBe('Already submitted')
  })

  it('falls back to UNKNOWN_ERROR + default message when the body is non-JSON garbage', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>503 nginx</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const err = await submitRelay(validRequest).catch((e) => e)
    expect(err).toBeInstanceOf(RelayerError)
    expect(err.code).toBe('UNKNOWN_ERROR')
    expect(err.httpStatus).toBe(500)
    expect(err.message).toBe('Relayer request failed (500)')
  })

  it('forwards the caller-supplied AbortSignal to fetch (so cancelTx propagates)', async () => {
    const ctrl = new AbortController()
    fetchMock.mockResolvedValueOnce(
      new Response('{"txHash":"0x00","status":"pending"}', { status: 200 }),
    )

    await submitRelay(validRequest, ctrl.signal)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(ctrl.signal)
  })
})

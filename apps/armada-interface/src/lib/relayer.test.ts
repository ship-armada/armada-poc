// ABOUTME: Tests for userFeeForKind + cctpMaxFeeForKind — the pure fee-resolution helpers consumed by modals (display) and xchain handlers (CCTP maxFee bound).
// ABOUTME: Also tests the submitRelay HTTP client — success path, RelayerError code/message decode, AbortSignal propagation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { RELAYER_ENDPOINTS, relayerEndpoint } from '@/config/relayer'
import {
  userFeeForKind,
  cctpFastFeeForAmount,
  cctpMaxFeeForKind,
  computeFeeBreakdown,
  feeModelForKind,
  submitRelay,
  fetchFees,
  fetchCctpDeliveryStatus,
  RelayerError,
  _fetchWithTimeout,
  type FeeSchedule,
  type RelayRequest,
  type RelayResponse,
} from './relayer'

function quoteWith(overrides: Partial<FeeSchedule['fees']> = {}): FeeSchedule {
  return {
    cacheId: 'test-cache',
    expiresAt: Date.now() + 60_000,
    chainId: 31337,
    broadcasterShieldedAddress: '0zk1test',
    fees: {
      transfer: '0',
      unshield: '0',
      crossContract: '0',
      crossChainShield: '0',
      crossChainUnshield: '0',
      shield: '0',
      shieldXchain: '0',
      ...overrides,
    },
  }
}

const ONE_USDC = 1_000_000n // 6 decimals
const HUNDRED_USDC = 100n * ONE_USDC

describe('userFeeForKind', () => {
  it('returns 0n for shield (user-submitted; no broadcaster fee path)', () => {
    expect(userFeeForKind('shield', HUNDRED_USDC)).toBe(0n)
  })

  describe('shield — Phase B3 gasless mode', () => {
    it('still returns 0n when gasless flag is omitted (direct-submit default)', () => {
      // WHY: any caller that doesn't pass {gasless:true} must see the unchanged Phase A
      // behavior. A regression here would have ShieldModal accidentally double-charge — the
      // modal would render a shield-tier fee even on the direct path where no relayer is in
      // the picture.
      const quote = quoteWith({ shield: '50000' })
      expect(userFeeForKind('shield', HUNDRED_USDC, quote)).toBe(0n)
      expect(userFeeForKind('shield', HUNDRED_USDC, quote, {})).toBe(0n)
      expect(userFeeForKind('shield', HUNDRED_USDC, quote, { gasless: false })).toBe(0n)
    })

    it('reads quote.fees.shield when gasless flag is set', () => {
      // WHY: pin the contract that gasless shield's user-visible fee is the relayer's `shield`
      // tier from the FeeSchedule (a per-chain quote since B2). Flat per-op USDC, not
      // proportional to amount — matches the unshield/transfer/yield pattern.
      const quote = quoteWith({ shield: '75000' }) // 0.075 USDC raw
      expect(userFeeForKind('shield', HUNDRED_USDC, quote, { gasless: true })).toBe(75_000n)
      expect(userFeeForKind('shield', ONE_USDC, quote, { gasless: true })).toBe(75_000n)
    })

    it('returns 0n with gasless=true but no quote (cold-load before useFees resolves)', () => {
      // WHY: same render-time UX rationale as the unshield-local cold-load case. The modal
      // shows "Loading…" via isFeeRefreshing; the fee value is 0n until the first quote lands.
      expect(userFeeForKind('shield', HUNDRED_USDC, null, { gasless: true })).toBe(0n)
      expect(userFeeForKind('shield', HUNDRED_USDC, undefined, { gasless: true })).toBe(0n)
    })

    it('coerces the quote\'s string fee back to bigint', () => {
      // WHY: same JSON-on-the-wire rationale as the other per-op tiers. The string-to-bigint
      // coercion is easy to drop in a refactor and would surface as a runtime TypeError.
      const quote = quoteWith({ shield: '12345' })
      const fee = userFeeForKind('shield', HUNDRED_USDC, quote, { gasless: true })
      expect(typeof fee).toBe('bigint')
      expect(fee).toBe(12_345n)
    })
  })

  it.each([
    ['transfer-shielded', 'transfer'],
    ['yield-deposit', 'crossContract'],
    ['yield-withdraw', 'crossContract'],
  ] as const)(
    '%s reads the flat per-op fee (raw USDC) from the quote\'s %s tier',
    (kind, tier) => {
      const quote = quoteWith({ [tier]: '75000' }) // 0.075 USDC raw
      expect(userFeeForKind(kind, HUNDRED_USDC, quote)).toBe(75_000n)
      // …and is amount-independent, same as unshield-local.
      expect(userFeeForKind(kind, ONE_USDC, quote)).toBe(75_000n)
    },
  )

  it.each([
    ['transfer-shielded'],
    ['yield-deposit'],
    ['yield-withdraw'],
  ] as const)('%s returns 0n when no quote is provided (cold-load)', (kind) => {
    expect(userFeeForKind(kind, HUNDRED_USDC)).toBe(0n)
    expect(userFeeForKind(kind, HUNDRED_USDC, null)).toBe(0n)
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

  it('returns 0 for direct-submit shield-xchain — CCTP fast-fee moved to its own channel', () => {
    // WHY: pre-fee-bundling, `userFeeForKind('shield-xchain', !gasless)` returned the CCTP fast-
    // fee and the tooltip labeled it "Relayer fee" — misleading on the direct path where no
    // broadcaster is involved. CCTP is now surfaced via `flowBreakdown.cctpFee` in the modal so
    // the tooltip can show it as "CCTP fee" alongside Protocol fee. `userFeeForKind` here means
    // strictly the broadcaster/relayer fee; 0 when no relayer participates.
    expect(userFeeForKind('shield-xchain', HUNDRED_USDC)).toBe(0n)
  })

  describe('shield-xchain — Phase B4 gasless mode', () => {
    it('returns 0n on direct-submit even when a quote is present (CCTP is its own channel)', () => {
      // WHY: regression guard for the broadcaster/CCTP split. Direct shield-xchain takes no
      // broadcaster fee; the CCTP fast-fee lives in `flowBreakdown.cctpFee` and is added to the
      // displayed total by ShieldModal. A regression here that re-routed CCTP through the
      // broadcaster slot would re-introduce the misleading "Relayer fee" label on direct.
      const quote = quoteWith({ shieldXchain: '500000' })
      expect(userFeeForKind('shield-xchain', HUNDRED_USDC, quote)).toBe(0n)
      expect(userFeeForKind('shield-xchain', HUNDRED_USDC, quote, { gasless: false })).toBe(0n)
    })

    it('reads quote.fees.shieldXchain when gasless flag is set', () => {
      // WHY: pin the contract that gasless shield-xchain's user-visible fee is the relayer's
      // `shieldXchain` tier from the SOURCE chain's FeeSchedule (per-chain quote since B2 —
      // gas costs differ on Base Sepolia vs Ethereum Sepolia). Flat per-op USDC, NOT
      // proportional to amount the way the direct CCTP fast-fee estimate is.
      const quote = quoteWith({ shieldXchain: '120000' }) // 0.12 USDC raw
      expect(userFeeForKind('shield-xchain', HUNDRED_USDC, quote, { gasless: true })).toBe(120_000n)
      expect(userFeeForKind('shield-xchain', ONE_USDC, quote, { gasless: true })).toBe(120_000n)
    })

    it('returns 0n with gasless=true but no quote (cold-load before useFees resolves)', () => {
      // WHY: same render-time UX rationale as the hub gasless cold-load case. The modal shows
      // "Loading…" via isFeeRefreshing; fee value is 0n until the per-chain quote lands.
      expect(userFeeForKind('shield-xchain', HUNDRED_USDC, null, { gasless: true })).toBe(0n)
      expect(userFeeForKind('shield-xchain', HUNDRED_USDC, undefined, { gasless: true })).toBe(0n)
    })
  })

  it('unshield-xchain (A5) reads the relayer\'s crossChainUnshield tier — independent of amount', () => {
    // WHY: A5 changes the semantic of unshield-xchain's user-visible "fee" from a proportional
    // CCTP estimate to the relayer's flat broadcaster fee. The CCTP fast-fee still applies but
    // is surfaced separately via `cctpFastFeeForAmount` since it deducts from the destination
    // mint rather than the user's shielded balance.
    const quote = quoteWith({ crossChainUnshield: '200000' }) // 0.20 USDC raw
    expect(userFeeForKind('unshield-xchain', HUNDRED_USDC, quote)).toBe(200_000n)
    expect(userFeeForKind('unshield-xchain', ONE_USDC, quote)).toBe(200_000n)
  })

  it('unshield-xchain returns 0n when no quote is provided (cold-load)', () => {
    expect(userFeeForKind('unshield-xchain', HUNDRED_USDC)).toBe(0n)
    expect(userFeeForKind('unshield-xchain', HUNDRED_USDC, null)).toBe(0n)
  })

  it('returns 0n on direct shield-xchain regardless of amount magnitude', () => {
    // WHY: post-CCTP-channel-split, direct shield-xchain has no broadcaster fee — the user pays
    // native gas themselves and CCTP fees flow through `flowBreakdown.cctpFee`. Independence
    // from amount distinguishes "no broadcaster" from "a small broadcaster fee that rounded to
    // zero," which would still scale with amount on bigger inputs. The amount-proportional
    // CCTP fast-fee math + rounding edges are covered by the `cctpFastFeeForAmount` test below.
    expect(userFeeForKind('shield-xchain', 0n)).toBe(0n)
    expect(userFeeForKind('shield-xchain', ONE_USDC)).toBe(0n)
    expect(userFeeForKind('shield-xchain', HUNDRED_USDC * 10_000n)).toBe(0n)
  })
})

describe('cctpFastFeeForAmount', () => {
  it('returns 2 bps of the amount (matches the server-side CCTP_FAST_FEE_BPS buffer)', () => {
    // WHY: pin the bps constant. A regression that flipped it to 1 bps would silently underbound
    // the on-chain maxFee and produce CCTP reverts; bumping to 3 bps would over-quote and confuse
    // users about delivery cost. Lock the wire format.
    expect(cctpFastFeeForAmount(HUNDRED_USDC)).toBe(20_000n)
    expect(cctpFastFeeForAmount(ONE_USDC)).toBe(200n)
    expect(cctpFastFeeForAmount(0n)).toBe(0n)
  })
})

describe('feeModelForKind', () => {
  it('classifies shield-xchain as fee-from-recipient (CCTP destination eats the only fee)', () => {
    // WHY: shield-xchain is still direct-submitted (Phase B's gasless shield path). The only
    // fee in flight is the CCTP fast-fee, which deducts from the destination mint. Misclassifying
    // it as `fee-on-top` would silently let the user type their full client-chain balance and
    // fail at submit when no extra USDC is available to cover a non-existent broadcaster output.
    expect(feeModelForKind('shield-xchain')).toBe('fee-from-recipient')
  })

  it('classifies unshield-xchain as fee-on-top-and-from-recipient (A5 — both fees apply)', () => {
    // WHY: A5 makes unshield-xchain unique among the seven kinds — it pays a relayer broadcaster
    // fee (on top of the entered amount, debited from shielded balance) AND a CCTP fast-fee
    // (deducted from the destination mint). Modelling both in one slot lets `computeFeeBreakdown`
    // emit the right `recipientReceives` AND `totalDeducted` AND `inputMax` numbers.
    expect(feeModelForKind('unshield-xchain')).toBe('fee-on-top-and-from-recipient')
  })

  it.each([
    ['unshield-local'],
    ['transfer-shielded'],
    ['yield-deposit'],
    ['yield-withdraw'],
  ] as const)('classifies %s as fee-on-top (relayer-mediated proof has extra broadcaster output)', (kind) => {
    // WHY: every relayer-mediated kind pays the broadcaster from a fresh unshield output sitting
    // alongside the user's primary spend, so the user is debited `amount + fee` and the recipient
    // (or the vault, for yield) receives the full `amount`.
    expect(feeModelForKind(kind)).toBe('fee-on-top')
  })

  it('classifies shield as no-fee (no broadcaster involvement; user submits directly)', () => {
    expect(feeModelForKind('shield')).toBe('no-fee')
  })

  it('classifies shield as fee-from-recipient when the gasless flag is set (B3 wrapper path)', () => {
    // WHY: with B3's UX-consistency pass, gasless shield uses `fee-from-recipient` semantics:
    // the user's entered `amount` is what's deducted (=permit's totalAmount); the wrapper
    // splits on-chain into `(amount - fee)` shielded + `fee` to the relayer. Recipient (the
    // user's shielded balance) receives `amount - fee`. Mirrors the unshield/cross-chain copy
    // where users always see "amount in / amount-fee out". The earlier `fee-on-top` model
    // (entered = what got shielded; user paid entered+fee) was confusing because shield-xchain
    // direct path was already fee-from-recipient via CCTP.
    expect(feeModelForKind('shield', { gasless: true })).toBe('fee-from-recipient')
    // Direct submit path stays no-fee (user pays ETH gas themselves; no relayer involved).
    expect(feeModelForKind('shield', { gasless: false })).toBe('no-fee')
    expect(feeModelForKind('shield', {})).toBe('no-fee')
  })

  it('classifies shield-xchain as fee-from-recipient on BOTH gasless and direct paths', () => {
    // WHY: B3's UX-consistency pass unified both shield-xchain paths under fee-from-recipient.
    // Gasless: wrapper's permit pulls `amount`, splits into `(amount - fee)` burned + `fee` to
    // relayer. Direct: CCTP fast-fee deducted from destination mint. Both result in the same
    // user-facing math: "you spend amount, you receive amount - fee shielded." The gasless
    // path replaces the relayer fee for the CCTP fast-fee but the on-top/from-recipient
    // distinction collapses to identical UX.
    expect(feeModelForKind('shield-xchain', { gasless: true })).toBe('fee-from-recipient')
    expect(feeModelForKind('shield-xchain', { gasless: false })).toBe('fee-from-recipient')
    expect(feeModelForKind('shield-xchain', {})).toBe('fee-from-recipient')
  })
})

describe('computeFeeBreakdown', () => {
  const AMOUNT = 5_000_000n // $5
  const FEE = 1_220_000n // $1.22
  const MAX = 10_000_000n // $10 shielded balance

  it('no-fee kinds: recipient = amount, total = amount, inputMax = max (no reservation)', () => {
    const r = computeFeeBreakdown('shield', AMOUNT, FEE, MAX)
    expect(r.recipientReceives).toBe(AMOUNT)
    expect(r.totalDeducted).toBe(AMOUNT)
    expect(r.inputMax).toBe(MAX)
  })

  it('fee-from-recipient: recipient = amount - fee, total = amount, inputMax = max', () => {
    // WHY: shield-xchain is the canonical fee-from-recipient kind post-A5. The only fee on this
    // path is the CCTP fast-fee, which deducts from the destination mint.
    const r = computeFeeBreakdown('shield-xchain', AMOUNT, FEE, MAX)
    expect(r.recipientReceives).toBe(AMOUNT - FEE)
    expect(r.totalDeducted).toBe(AMOUNT)
    expect(r.inputMax).toBe(MAX)
  })

  it('fee-on-top: recipient = amount, total = amount + fee, inputMax = max - fee', () => {
    // WHY: pins the load-bearing A3 invariant. recipient gets the full amount; total deducted
    // shows the user the real spend; inputMax reserves the fee so amount + fee ≤ shielded.
    const r = computeFeeBreakdown('unshield-local', AMOUNT, FEE, MAX)
    expect(r.recipientReceives).toBe(AMOUNT)
    expect(r.totalDeducted).toBe(AMOUNT + FEE)
    expect(r.inputMax).toBe(MAX - FEE)
  })

  it('fee-from-recipient floors at 0n when fee exceeds amount (no negative recipientReceives)', () => {
    // WHY: defensive — a misconfigured CCTP fee that exceeds the shield amount must NOT
    // produce a bigint underflow surfacing as "you'll receive 18446744073709551615 USDC".
    const tinyAmount = 100n
    const r = computeFeeBreakdown('shield-xchain', tinyAmount, FEE, MAX)
    expect(r.recipientReceives).toBe(0n)
    expect(r.totalDeducted).toBe(tinyAmount)
  })

  it('fee-on-top floors inputMax at 0n when fee exceeds shielded balance', () => {
    // WHY: same defensive bound on the input side. If the relayer fee exceeds the user's
    // entire shielded balance, the input should accept 0n (and Continue stays disabled),
    // not wrap around.
    const tinyMax = 100n
    const r = computeFeeBreakdown('unshield-local', AMOUNT, FEE, tinyMax)
    expect(r.inputMax).toBe(0n)
  })

  it('fee-on-top-and-from-recipient (A5 unshield-xchain): both fees applied independently', () => {
    // WHY: A5's unique two-fee model. recipient gets `amount - secondaryFee` (CCTP), user is
    // debited `amount + fee` (broadcaster), input cap reserves `fee` so user can't type past
    // their shielded balance. A regression that ignored `secondaryFee` would over-quote the
    // recipient's mint, a regression that double-counted it would under-quote.
    const cctpFee = 10_000n // 0.01 USDC raw
    const r = computeFeeBreakdown('unshield-xchain', AMOUNT, FEE, MAX, { secondaryFee: cctpFee })
    expect(r.recipientReceives).toBe(AMOUNT - cctpFee)
    expect(r.totalDeducted).toBe(AMOUNT + FEE)
    expect(r.inputMax).toBe(MAX - FEE)
  })

  it('fee-on-top-and-from-recipient floors recipientReceives at 0n when CCTP fee exceeds amount', () => {
    // WHY: defensive — same logic as the simple fee-from-recipient flooring. A misconfigured CCTP
    // fee on a tiny xchain unshield must NOT underflow to 2^256 - 1.
    const tinyAmount = 5n
    const cctpFee = 10_000n
    const r = computeFeeBreakdown('unshield-xchain', tinyAmount, FEE, MAX, { secondaryFee: cctpFee })
    expect(r.recipientReceives).toBe(0n)
    expect(r.totalDeducted).toBe(tinyAmount + FEE)
  })

  it('fee-on-top-and-from-recipient defaults secondaryFee to 0n when omitted', () => {
    // WHY: backwards-compat for callers that don't pass `secondaryFee` — the helper should still
    // produce a meaningful breakdown (recipient gets full amount). A regression that NaN'd or
    // threw on missing secondaryFee would crash modals during the cold-load render before the
    // CCTP fee is computed.
    const r = computeFeeBreakdown('unshield-xchain', AMOUNT, FEE, MAX)
    expect(r.recipientReceives).toBe(AMOUNT)
    expect(r.totalDeducted).toBe(AMOUNT + FEE)
    expect(r.inputMax).toBe(MAX - FEE)
  })

  it('protocolFee subtracts from recipient on fee-from-recipient (shield-xchain with shield-fee-module)', () => {
    // WHY: cross-chain shield deducts BOTH the broadcaster/CCTP fee (already plumbed via `fee`)
    // AND the on-chain shield fee module's take from the user's entered amount. recipientReceives
    // must reflect both deductions so the user sees the true shielded value.
    const protocolFee = 500_000n // 0.5 USDC (50 bps of 100)
    const r = computeFeeBreakdown('shield-xchain', AMOUNT, FEE, MAX, { protocolFee })
    expect(r.recipientReceives).toBe(AMOUNT - FEE - protocolFee)
    expect(r.totalDeducted).toBe(AMOUNT)
    expect(r.inputMax).toBe(MAX)
  })

  it('protocolFee subtracts from recipient on no-fee (direct hub shield with fee-module take)', () => {
    // WHY: direct hub shield has no broadcaster fee (`feeModelForKind('shield')` returns 'no-fee')
    // but the on-chain shield fee module still takes its bps. Without protocolFee, recipientReceives
    // over-reports — UI says "100 shielded" when reality is "99.5 shielded". With it plumbed, both
    // halves reconcile.
    const protocolFee = 500_000n
    const r = computeFeeBreakdown('shield', AMOUNT, 0n, MAX, { protocolFee })
    expect(r.recipientReceives).toBe(AMOUNT - protocolFee)
    expect(r.totalDeducted).toBe(AMOUNT)
    expect(r.inputMax).toBe(MAX)
  })

  it('protocolFee defaults to 0n when omitted (no behavior change for callers that do not opt in)', () => {
    // WHY: backwards-compat — every existing call site (49 tests above) passes nothing for
    // protocolFee. Default must keep the current numbers exact so this seam is purely additive.
    // shield-xchain is the cleanest fee-from-recipient regression test.
    const r = computeFeeBreakdown('shield-xchain', AMOUNT, FEE, MAX)
    expect(r.recipientReceives).toBe(AMOUNT - FEE)
    expect(r.totalDeducted).toBe(AMOUNT)
    expect(r.inputMax).toBe(MAX)
  })

  it('protocolFee floors recipientReceives at 0n when total deduction exceeds amount', () => {
    // WHY: defensive floor — a misconfigured fee module or stale quote could in principle make
    // (broadcasterFee + protocolFee) > amount. Returning a negative bigint would crash the UI.
    const protocolFee = AMOUNT
    const r = computeFeeBreakdown('shield-xchain', AMOUNT, FEE, MAX, { protocolFee })
    expect(r.recipientReceives).toBe(0n)
  })

  it('gasless shield: opts.gasless routes through fee-from-recipient so recipientReceives subtracts BOTH broadcaster + protocol fees', () => {
    // WHY: regression test for the deposit fee tooltip bug. feeModelForKind('shield') returns
    // 'no-fee' by default (direct hub shield), which only subtracts protocolFee and ignores
    // the broadcaster fee. With the gasless permit path, the wrapper deducts both, so the
    // helper must route through 'fee-from-recipient' to keep recipientReceives honest.
    const protocolFee = 500_000n
    const direct = computeFeeBreakdown('shield', AMOUNT, FEE, MAX, { protocolFee })
    // Direct (no opt) still uses no-fee: ignores broadcaster fee.
    expect(direct.recipientReceives).toBe(AMOUNT - protocolFee)

    const gasless = computeFeeBreakdown('shield', AMOUNT, FEE, MAX, {
      protocolFee,
      gasless: true,
    })
    // Gasless routes through fee-from-recipient: deducts both.
    expect(gasless.recipientReceives).toBe(AMOUNT - FEE - protocolFee)
    expect(gasless.totalDeducted).toBe(AMOUNT)
    expect(gasless.inputMax).toBe(MAX)
  })

  it('protocolFee combines with secondaryFee on unshield-xchain (CCTP fast-fee + protocol take)', () => {
    // WHY: covers the cross-chain shape — both `secondaryFee` (CCTP) and `protocolFee` deduct
    // from the recipient side. Future-proofing for unshield-xchain if it ever surfaces a
    // protocol-side take; today protocolFee defaults to 0 for this kind so callers can opt in.
    const cctpFee = 2_000n
    const protocolFee = 100_000n
    const r = computeFeeBreakdown('unshield-xchain', AMOUNT, FEE, MAX, {
      secondaryFee: cctpFee,
      protocolFee,
    })
    expect(r.recipientReceives).toBe(AMOUNT - cctpFee - protocolFee)
    expect(r.totalDeducted).toBe(AMOUNT + FEE)
    expect(r.inputMax).toBe(MAX - FEE)
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
    idempotencyKey: '01J-tx-ulid',
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
    // The client-generated idempotency key must travel in the POST body so the relayer can dedup
    // a re-POST and return the already-broadcast hash (T-M3/S-M1).
    expect(JSON.parse(init.body as string).idempotencyKey).toBe('01J-tx-ulid')
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

  it('aborts the underlying fetch when the caller signal aborts (cancelTx propagates through the combined signal)', async () => {
    // P0-11: fetchWithTimeout now passes a COMBINED signal (caller ∪ timeout) to fetch, so we no
    // longer assert identity — instead verify the caller's abort still drives the fetch signal.
    const ctrl = new AbortController()
    fetchMock.mockResolvedValueOnce(
      new Response('{"txHash":"0x00","status":"pending"}', { status: 200 }),
    )

    await submitRelay(validRequest, ctrl.signal)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal!.aborted).toBe(false)
    ctrl.abort()
    expect(init.signal!.aborted).toBe(true)
  })

  it('throws a transient RelayerError when the relayer does not respond within the timeout (P0-11)', async () => {
    // fetch that only ever settles when its signal aborts — i.e. a hung relayer.
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )

    const err = await _fetchWithTimeout('http://relayer.test', { method: 'GET' }, undefined, 20)
      .then(() => null, (e) => e)

    expect(err).toBeInstanceOf(RelayerError)
    expect(err.code).toBe('RELAYER_BUSY')
    expect(err.httpStatus).toBe(0)
  })

  it('rethrows a caller-initiated abort untouched (not a RelayerError) so cancel stays cancel (P0-11)', async () => {
    const ctrl = new AbortController()
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )

    const p = _fetchWithTimeout('http://relayer.test', { method: 'GET' }, ctrl.signal, 10_000)
      .catch((e) => e)
    ctrl.abort()
    const err = await p

    expect(err).not.toBeInstanceOf(RelayerError)
  })
})

describe('fetchCctpDeliveryStatus (T-M7 Option B)', () => {
  const fetchMock = vi.fn()
  const ORIGINAL_FETCH = globalThis.fetch
  const HASH = '0xmessagehash'

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterAll(() => { globalThis.fetch = ORIGINAL_FETCH })

  function jsonRes(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  it('maps a delivered body to the destination tx hash', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'delivered', destTxHash: '0xdest', amount: '999', feeExecuted: '1' }))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'delivered', destTxHash: '0xdest', amount: '999', feeExecuted: '1' })
  })

  it('maps pending and failed', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'pending' }))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'pending' })
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'failed', error: 'mint reverted' }))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'failed', error: 'mint reverted' })
  })

  it('returns unavailable on 404 (endpoint not deployed) so the caller falls back to the scan', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'not found' }, 404))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'unavailable' })
  })

  it('returns unavailable on a 5xx (relayer degraded)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'boom' }, 503))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'unavailable' })
  })

  it('returns unavailable on a network error (relayer down)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'unavailable' })
  })

  it('returns unavailable on a malformed body (missing destTxHash on delivered)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'delivered' }))
    expect(await fetchCctpDeliveryStatus(HASH)).toEqual({ kind: 'unavailable' })
  })

  it('propagates a caller abort rather than swallowing it as unavailable', async () => {
    const ctrl = new AbortController()
    fetchMock.mockImplementationOnce(() => { ctrl.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')) })
    await expect(fetchCctpDeliveryStatus(HASH, ctrl.signal)).rejects.toThrow()
  })
})

describe('fetchFees — relayer wire-field normalization', () => {
  const fetchMock = vi.fn()
  const ORIGINAL_FETCH = globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  // WHY: the relayer's /fees wire contract names the broadcaster 0zk field `broadcasterRailgunAddress`
  // (its BROADCASTER_RAILGUN_ADDRESS env var), but the interface uses the SDK-aligned
  // `broadcasterShieldedAddress` everywhere. fetchFees is the one boundary that must remap it — a
  // regression here silently feeds an undefined broadcaster address into every relayer-mediated proof.
  const wireBody = (broadcasterKey: string) => ({
    cacheId: 'c', expiresAt: 0, chainId: 31337,
    [broadcasterKey]: '0zk1broadcaster',
    fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
  })

  it('maps the relayer wire `broadcasterRailgunAddress` → `broadcasterShieldedAddress`', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(wireBody('broadcasterRailgunAddress')), { status: 200 }))
    const schedule = await fetchFees()
    expect(schedule.broadcasterShieldedAddress).toBe('0zk1broadcaster')
  })

  it('also accepts a future relayer already sending `broadcasterShieldedAddress`', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(wireBody('broadcasterShieldedAddress')), { status: 200 }))
    const schedule = await fetchFees()
    expect(schedule.broadcasterShieldedAddress).toBe('0zk1broadcaster')
  })

  it('defaults to empty string when neither wire name is present', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(wireBody('somethingElse')), { status: 200 }))
    const schedule = await fetchFees()
    expect(schedule.broadcasterShieldedAddress).toBe('')
  })
})

// ABOUTME: Submit-time fee-quote refresh + reviewed-vs-fresh fee compare, shared by the shield/unshield/transfer/yield submit paths.
// ABOUTME: Always refetches a fresh cacheId before proof gen (a stale cacheId is the FEE_EXPIRED cause); flags when the fee changed so the modal re-reviews instead of silently swapping the reviewed fee.

import type { FeeSchedule } from '@/lib/relayer'

export interface ResolveFreshQuoteResult {
  /** The freshly fetched quote to submit with; null when the relayer couldn't be reached. */
  quote: FeeSchedule | null
  /** True when the fresh fee differs from what the user reviewed — the caller should re-review (not submit). */
  feeChanged: boolean
}

/**
 * Force a fresh quote and compare its fee against the one the user reviewed.
 *
 *   - `quote === null`   → relayer unreachable; the caller surfaces "could not fetch a quote".
 *   - `feeChanged`       → the fee moved since Review; the caller bounces to Review (don't submit).
 *   - otherwise          → submit with `quote` (a fresh `cacheId`; the fee matches what was reviewed).
 *
 * Always refetches — never reuses the cached quote — so the `cacheId` frozen into the proof is as
 * fresh as possible before the 20–30s proof generation, which is where a stale cacheId turns into a
 * relayer `FEE_EXPIRED`. A rotated `cacheId`/broadcaster address with an UNCHANGED fee flows through
 * transparently; only a fee-value change gates re-review, preserving "what you saw is what you pay".
 *
 * `feeOf` extracts the comparable fee (the relayer tier for the kind). Exact bigint equality — fees
 * are integer amounts, no tolerance.
 */
export async function resolveFreshQuote(args: {
  refresh: () => Promise<FeeSchedule | null>
  reviewedFee: bigint
  feeOf: (schedule: FeeSchedule) => bigint
}): Promise<ResolveFreshQuoteResult> {
  const quote = await args.refresh()
  if (!quote) return { quote: null, feeChanged: false }
  return { quote, feeChanged: args.feeOf(quote) !== args.reviewedFee }
}

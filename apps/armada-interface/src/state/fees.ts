// ABOUTME: Cached fee quote from the relayer. UI reads `feeQuoteAtom`; staleness is derived on the CLIENT clock from when we fetched it.
// ABOUTME: useFees() (hooks/) owns refresh + auto-refetch and sets feeQuoteFetchedAtAtom alongside the quote; this module just exposes the atoms + the staleness window.

import { atom } from 'jotai'
import type { FeeSchedule } from '@/lib/relayer'
import { nowAtom } from './time'

export const feeQuoteAtom = atom<FeeSchedule | null>(null)

/**
 * Client-clock timestamp (`Date.now()`) when the hub quote in `feeQuoteAtom` was fetched. Set by
 * `useFees` whenever it mirrors a fresh hub quote. Staleness is computed from THIS, not from the
 * server's `expiresAt`: comparing the relayer's wall-clock `expiresAt` against client `Date.now()`
 * makes a few minutes of clock skew read as "always expired" → a refetch/re-quote storm. (P1-28)
 */
export const feeQuoteFetchedAtAtom = atom<number | null>(null)

/**
 * Treat a quote as stale this long after we fetched it. Conservatively below the relayer's
 * documented 5-minute cache TTL so we re-quote before the server-side `cacheId` actually expires.
 * If the relayer's TTL changes, lower this to stay under it.
 */
export const FEE_QUOTE_STALE_AFTER_MS = 4 * 60_000

/**
 * Derived: should the cached quote be re-fetched before use? Pure client clock — skew-immune.
 * Depends on `nowAtom` (not a bare `Date.now()`) so it actually RECOMPUTES as time passes —
 * a derived atom reading `Date.now()` directly would cache the first result forever (Date.now is
 * not a tracked dependency). `nowAtom` ticks ~once a minute, which is ample granularity against
 * the 4-minute staleness window. `fetchedAt` is recorded on the same client clock as `nowAtom`.
 */
export const feeQuoteIsStaleAtom = atom((get) => {
  const q = get(feeQuoteAtom)
  const fetchedAt = get(feeQuoteFetchedAtAtom)
  if (!q || fetchedAt === null) return true
  return get(nowAtom) - fetchedAt >= FEE_QUOTE_STALE_AFTER_MS
})

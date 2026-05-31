// ABOUTME: Fee quote manager — wraps fetchFees() in a React Query that auto-refetches near expiry, exponentially backs off on cold-start failures, and pauses when the tab is hidden.
// ABOUTME: Mirrors the latest quote into feeQuoteAtom so non-React readers (handlers, modal tests) stay on the existing atom-based contract.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtom, useAtomValue } from 'jotai'
import { useEffect } from 'react'
import { feeQuoteAtom, feeQuoteIsStaleAtom } from '@/state/fees'
import { tabVisibleAtom } from '@/state/visibility'
import { fetchFees, type FeeSchedule } from '@/lib/relayer'
import { trackError } from '@/lib/telemetry'

export interface UseFeesOptions {
  /**
   * Phase B2+ per-chain quoting — when set, fetches the FeeSchedule for THIS chain instead of
   * the hub default. Used by B4's shield-xchain gasless path which needs the source client
   * chain's `shieldXchain` tier (gas costs differ per chain). When omitted, returns the hub
   * schedule and mirrors it into `feeQuoteAtom` for non-React consumers (existing Phase A
   * behaviour, unchanged).
   */
  chainId?: number
}

export interface UseFeesResult {
  quote: FeeSchedule | null
  isStale: boolean
  /**
   * Force a fresh fetch — usually unnecessary; the query auto-refreshes near expiry. Resolves to
   * the freshest schedule so callers can submit with the new cacheId immediately without waiting
   * for a re-render to surface the updated atom value.
   */
  refresh: () => Promise<FeeSchedule | null>
}

/** Base key for the hub fees query (no chainId override). */
export const FEES_QUERY_KEY = ['fees'] as const

/** Per-chain key — keep separate so React Query caches per chain independently. */
function feesQueryKey(chainId: number | undefined): readonly unknown[] {
  return chainId === undefined ? FEES_QUERY_KEY : (['fees', chainId] as const)
}

/** Re-fetch this many ms before the relayer's quote expires so callers never see a stale quote. */
const REFRESH_LEAD_MS = 30_000
/** Fallback refetch cadence when the cached quote has no expiresAt (shouldn't happen — defensive). */
const FALLBACK_REFETCH_MS = 60_000
/** Cold-start retry schedule: 5s → 15s → 30s → 60s, then 60s indefinitely. */
const COLD_RETRY_SCHEDULE_MS = [5_000, 15_000, 30_000, 60_000] as const

/**
 * Compute the next refetch delay so we re-fetch ~REFRESH_LEAD_MS before the quote expires.
 * Floor at 1s so a near-expired quote doesn't trigger a tight refetch loop.
 */
function refetchDelayFor(quote: FeeSchedule | null): number {
  if (!quote) return FALLBACK_REFETCH_MS
  const ms = quote.expiresAt - Date.now() - REFRESH_LEAD_MS
  return Math.max(1_000, ms)
}

export function useFees(opts: UseFeesOptions = {}): UseFeesResult {
  const chainId = opts.chainId
  const isHubQuote = chainId === undefined
  const [atomQuote, setAtomQuote] = useAtom(feeQuoteAtom)
  const hubIsStale = useAtomValue(feeQuoteIsStaleAtom)
  const tabVisible = useAtomValue(tabVisibleAtom)
  const queryClient = useQueryClient()
  const queryKey = feesQueryKey(chainId)

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchFees(signal, chainId),
    // Tab-visibility gate: when hidden the interval pauses; resumes on visibility flip.
    refetchInterval: ({ state }) => (tabVisible ? refetchDelayFor(state.data ?? null) : false),
    refetchIntervalInBackground: false,
    // Refetch on focus if the cached quote is past its refresh window — cheap correctness.
    refetchOnWindowFocus: 'always',
    // Cold-start retry with the explicit schedule above. Loops 60s indefinitely until success
    // because the modal flows cannot proceed without a quote.
    retry: true,
    retryDelay: attemptIndex =>
      COLD_RETRY_SCHEDULE_MS[Math.min(attemptIndex, COLD_RETRY_SCHEDULE_MS.length - 1)]!,
    staleTime: 0,
    gcTime: 60 * 60_000,
  })

  // Mirror the latest successful HUB fetch into feeQuoteAtom so non-React consumers (handlers
  // calling fetchFees directly, modal tests that seed the atom) keep working unchanged. Per-chain
  // quotes are scoped to their React Query consumer and intentionally NOT mirrored — a single
  // global atom can't represent N per-chain schedules at once, and B4's only consumer
  // (ShieldModal) reads from the query directly.
  useEffect(() => {
    if (isHubQuote && query.data) setAtomQuote(query.data)
  }, [isHubQuote, query.data, setAtomQuote])

  // Surface persistent fetch errors via telemetry. React Query retries internally; we only emit
  // once per error transition rather than per attempt to avoid noisy logs during a relayer outage.
  useEffect(() => {
    if (query.error) {
      trackError('useFees.query', query.error, { scope: 'fees', message: 'fetchFees failed' })
    }
  }, [query.error])

  const refresh = async (): Promise<FeeSchedule | null> => {
    const result = await queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => fetchFees(signal, chainId),
      // Bypass any staleTime so a manual refresh always hits the relayer.
      staleTime: 0,
    }).catch((err: unknown) => {
      trackError('useFees.refresh', err, { scope: 'fees', message: 'fetchFees failed' })
      return null
    })
    if (isHubQuote && result) setAtomQuote(result)
    return result
  }

  // Per-chain quotes don't have an atom mirror, so derive `isStale` from the query data when we
  // can't use the hub atom. A quote is stale once `expiresAt - now <= REFRESH_LEAD_MS` — same
  // semantic the hub atom uses, just computed inline. Returns false when no quote loaded yet
  // (matches the atom's behaviour pre-first-fetch).
  const liveQuote = query.data ?? null
  const perChainIsStale =
    liveQuote === null ? false : liveQuote.expiresAt - Date.now() <= REFRESH_LEAD_MS
  const isStale = isHubQuote ? hubIsStale : perChainIsStale

  // Prefer the live query data, falling back to the atom for hub-only (covers the brief window
  // before the first useEffect tick has mirrored a freshly fetched quote into the atom). For
  // per-chain queries the atom may belong to a different chain entirely, so we DON'T fall back.
  return {
    quote: isHubQuote ? (query.data ?? atomQuote) : (query.data ?? null),
    isStale,
    refresh,
  }
}

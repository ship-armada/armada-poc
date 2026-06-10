// ABOUTME: Fee quote manager — wraps fetchFees() in a React Query that auto-refetches on a fixed client-clock cadence, backs off on cold-start failures, and pauses when the tab is hidden.
// ABOUTME: Mirrors the latest quote + its client fetch time into feeQuoteAtom/feeQuoteFetchedAtAtom so non-React readers (handlers, modal tests) stay on the existing atom-based contract.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import {
  feeQuoteAtom,
  feeQuoteFetchedAtAtom,
  feeQuoteIsStaleAtom,
  FEE_QUOTE_STALE_AFTER_MS,
} from '@/state/fees'
import { tabVisibleAtom } from '@/state/visibility'
import { fetchFees, type FeeSchedule } from '@/lib/relayer'
import { isRelayerConfigured } from '@/config/network'
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
   * True once the fee query has failed at least 3 times in a row — the relayer is likely down.
   * React Query keeps retrying (the modal can't proceed without a quote), but the UI surfaces
   * this so the fee row reads "unavailable" instead of an indefinite "loading…". (P1-28)
   */
  isUnavailable: boolean
  /**
   * Force a fresh fetch — usually unnecessary; the query auto-refreshes. Resolves to the freshest
   * schedule so callers can submit with the new cacheId immediately without waiting for a re-render.
   */
  refresh: () => Promise<FeeSchedule | null>
}

/** Base key for the hub fees query (no chainId override). */
export const FEES_QUERY_KEY = ['fees'] as const

/** Per-chain key — keep separate so React Query caches per chain independently. */
function feesQueryKey(chainId: number | undefined): readonly unknown[] {
  return chainId === undefined ? FEES_QUERY_KEY : (['fees', chainId] as const)
}

/** Re-fetch this many ms before a quote would go stale so callers never submit a stale cacheId. */
const REFRESH_LEAD_MS = 30_000
/**
 * Fixed auto-refetch cadence (P1-28). Derived purely on the client clock from the staleness window
 * — NOT from the relayer's `expiresAt`, which is server wall-clock and produced a 1s refetch hammer
 * under a few minutes of clock skew. Floored at 30s as a belt-and-braces against a tiny window.
 */
const AUTO_REFETCH_MS = Math.max(30_000, FEE_QUOTE_STALE_AFTER_MS - REFRESH_LEAD_MS)
/** Number of consecutive failures before we treat the relayer as unavailable in the UI. */
const UNAVAILABLE_AFTER_FAILURES = 3
/** Cold-start retry schedule: 5s → 15s → 30s → 60s, then 60s indefinitely. */
const COLD_RETRY_SCHEDULE_MS = [5_000, 15_000, 30_000, 60_000] as const

export function useFees(opts: UseFeesOptions = {}): UseFeesResult {
  const chainId = opts.chainId
  const isHubQuote = chainId === undefined
  const [atomQuote, setAtomQuote] = useAtom(feeQuoteAtom)
  const setFetchedAt = useSetAtom(feeQuoteFetchedAtAtom)
  const hubIsStale = useAtomValue(feeQuoteIsStaleAtom)
  const tabVisible = useAtomValue(tabVisibleAtom)
  const queryClient = useQueryClient()
  const queryKey = feesQueryKey(chainId)

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchFees(signal, chainId),
    // Don't fetch when no relayer is configured (sepolia + unset VITE_RELAYER_URL) — otherwise the
    // empty base URL resolves to the app's own origin and retries an HTML 404 forever. (P0-10)
    enabled: isRelayerConfigured(),
    // Fixed client-clock cadence; pauses when the tab is hidden (resumes on visibility flip).
    refetchInterval: () => (tabVisible ? AUTO_REFETCH_MS : false),
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

  // Mirror the latest successful HUB fetch into feeQuoteAtom + feeQuoteFetchedAtAtom so non-React
  // consumers (handlers calling fetchFees directly, modal tests that seed the atom) keep working.
  // `dataUpdatedAt` is React Query's client-clock timestamp for when the data landed — the right
  // basis for skew-free staleness. Per-chain quotes are scoped to their React Query consumer and
  // intentionally NOT mirrored (a single global atom can't represent N per-chain schedules).
  useEffect(() => {
    if (isHubQuote && query.data) {
      setAtomQuote(query.data)
      setFetchedAt(query.dataUpdatedAt || Date.now())
    }
  }, [isHubQuote, query.data, query.dataUpdatedAt, setAtomQuote, setFetchedAt])

  // Surface a sustained relayer outage exactly once (not per retry) via telemetry; reset on
  // recovery so a later outage reports again. `failureReason` carries the current error while
  // React Query is mid-retry (it never settles to `error` status because retry is infinite).
  const isUnavailable = query.failureCount >= UNAVAILABLE_AFTER_FAILURES
  const outageReportedRef = useRef(false)
  useEffect(() => {
    if (isUnavailable && !outageReportedRef.current) {
      outageReportedRef.current = true
      trackError('useFees.unavailable', query.failureReason ?? new Error('fees unavailable'), {
        scope: 'fees',
        message: `fee quote unavailable after ${query.failureCount} attempts`,
      })
    } else if (!isUnavailable && query.isSuccess) {
      outageReportedRef.current = false
    }
  }, [isUnavailable, query.isSuccess, query.failureReason, query.failureCount])

  const refresh = async (): Promise<FeeSchedule | null> => {
    // No relayer configured → nothing to fetch (and the empty URL would hit our own origin).
    if (!isRelayerConfigured()) return null
    const result = await queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => fetchFees(signal, chainId),
      // Bypass any staleTime so a manual refresh always hits the relayer.
      staleTime: 0,
    }).catch((err: unknown) => {
      trackError('useFees.refresh', err, { scope: 'fees', message: 'fetchFees failed' })
      return null
    })
    if (isHubQuote && result) {
      setAtomQuote(result)
      setFetchedAt(Date.now())
    }
    return result
  }

  // Per-chain quotes have no atom mirror, so derive staleness from React Query's client-clock
  // `dataUpdatedAt` (same skew-free basis the hub atom uses). 0 means "not fetched yet" → not stale.
  const perChainIsStale =
    query.dataUpdatedAt === 0 ? false : Date.now() - query.dataUpdatedAt >= FEE_QUOTE_STALE_AFTER_MS
  const isStale = isHubQuote ? hubIsStale : perChainIsStale

  // Prefer the live query data, falling back to the atom for hub-only (covers the brief window
  // before the first useEffect tick has mirrored a freshly fetched quote into the atom). For
  // per-chain queries the atom may belong to a different chain entirely, so we DON'T fall back.
  return {
    quote: isHubQuote ? (query.data ?? atomQuote) : (query.data ?? null),
    isStale,
    isUnavailable,
    refresh,
  }
}

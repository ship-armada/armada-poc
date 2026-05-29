// ABOUTME: useRelayerHealth — React Query wrapper around /health for the modal banner + Settings auto-surface.
// ABOUTME: Conservative polling — modals only need health at submit-time, so a 60s interval is enough; visibility-gated to avoid background drain.

import { useQuery } from '@tanstack/react-query'
import { fetchHealth, type RelayerHealthResponse } from '@/lib/relayer'

export interface UseRelayerHealthOptions {
  /**
   * When false, the query is paused. Used by modal callers to only poll while the modal is open.
   * Defaults to true.
   */
  enabled?: boolean
}

/**
 * Subscribe to the relayer's /health snapshot. Returns the parsed response + a `isDegraded`
 * convenience derived value — `true` when the relayer reports `stale` or `unhealthy`. Modals use
 * `isDegraded` to surface the wallet-override banner.
 *
 * Failures (relayer entirely unreachable) surface as `data: undefined` + an `error`. Treat the
 * total-unreachable state as the most-degraded signal — same UX as `unhealthy`.
 */
export function useRelayerHealth(opts: UseRelayerHealthOptions = {}) {
  const query = useQuery<RelayerHealthResponse>({
    queryKey: ['relayer-health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    enabled: opts.enabled !== false,
    // Don't aggressively retry — if the relayer is down, the banner should reflect that and the
    // user opts into the wallet path. A 30-second retry would mask a real outage.
    retry: 1,
    staleTime: 30_000,
  })

  const data = query.data
  const isDegraded =
    !!query.error || // unreachable → degrade
    (data ? data.status === 'stale' || data.status === 'unhealthy' : false)

  return {
    data,
    error: query.error,
    isLoading: query.isLoading,
    isDegraded,
    refetch: query.refetch,
  }
}

// ABOUTME: Subscribes to the react-query cache and surfaces when any query
// ABOUTME: has stale data due to a paused network or failing refetch.

import { useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient, Query } from '@tanstack/react-query'

export type StaleReason = 'paused' | 'error'

export interface StaleDataSignal {
  isStale: boolean
  reason: StaleReason | null
}

const NOT_STALE: StaleDataSignal = { isStale: false, reason: null }
const STALE_PAUSED: StaleDataSignal = { isStale: true, reason: 'paused' }
const STALE_ERROR: StaleDataSignal = { isStale: true, reason: 'error' }

/**
 * True iff this query already has data AND its most recent fetch attempt
 * either failed (we still have stale data) or is paused because the network
 * went offline. Pure render-time read — no side effects.
 */
function queryIsStale(query: Query): StaleReason | null {
  const state = query.state
  if (state.data === undefined) return null
  if (state.fetchStatus === 'paused') return 'paused'
  if (state.error !== null) return 'error'
  return null
}

function readSignal(client: QueryClient): StaleDataSignal {
  const cache = client.getQueryCache()
  let sawError = false
  let sawPaused = false
  for (const query of cache.getAll()) {
    const reason = queryIsStale(query)
    if (reason === 'paused') sawPaused = true
    else if (reason === 'error') sawError = true
  }
  // 'paused' wins over 'error' — explicit offline is the clearer UX.
  if (sawPaused) return STALE_PAUSED
  if (sawError) return STALE_ERROR
  return NOT_STALE
}

/**
 * Reports when any query in the react-query cache has stale data due to
 * a paused network or a failing refetch after a prior successful fetch.
 * Returns `{ isStale: false, reason: null }` during the initial load —
 * skeletons cover that case.
 */
export function useStaleDataBanner(): StaleDataSignal {
  const client = useQueryClient()

  // Snapshots must be referentially stable when the signal is unchanged —
  // `useSyncExternalStore` compares with `Object.is`. We achieve that by
  // returning one of three module-level constants.
  const getSnapshot = () => readSignal(client)

  const subscribe = (onChange: () => void) => {
    const cache = client.getQueryCache()
    return cache.subscribe(onChange)
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

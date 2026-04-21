// ABOUTME: ENS name resolution backed by react-query + IndexedDB cache.
// ABOUTME: Per-address queries dedupe across subscribers; 24h staleTime matches IDB TTL.

import { useEffect, useMemo, useCallback } from 'react'
import { atom, useAtom } from 'jotai'
import type { JsonRpcProvider } from 'ethers'
import { useQueries } from '@tanstack/react-query'
import { cacheENS, getCachedENS } from '../lib/cache.js'
import { truncateAddress } from '../lib/format.js'

/** Map of address (lowercase) → ENS name. Mirrors react-query's cache for legacy consumers. */
export const ensMapAtom = atom<Map<string, string>>(new Map())

export interface UseENSConfig {
  provider: JsonRpcProvider | null
  addresses: string[]
}

export interface UseENSResult {
  resolve: (addr: string) => string | null
  displayName: (addr: string) => string
}

const ENS_STALE_MS = 24 * 60 * 60 * 1000 // 24 hours
const ENS_GC_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function ensQueryKey(addr: string): [string, string] {
  return ['ens', addr.toLowerCase()]
}

async function resolveEnsName(
  provider: JsonRpcProvider,
  address: string,
): Promise<string | null> {
  const lower = address.toLowerCase()
  const cached = await getCachedENS(lower)
  if (cached !== null) return cached
  const name = await provider.lookupAddress(address)
  if (name) {
    await cacheENS(lower, name).catch(() => {})
    return name
  }
  return null
}

/**
 * Hook for lazy ENS resolution with caching.
 * Resolves addresses via react-query (dedup across subscribers) with a 24h staleTime
 * matching the IndexedDB TTL. Unresolvable addresses resolve to `null` — react-query
 * caches the null, no retry storms.
 */
export function useENS(config: UseENSConfig): UseENSResult {
  const { provider, addresses } = config
  const [ensMap, setEnsMap] = useAtom(ensMapAtom)

  const uniqueAddresses = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const addr of addresses) {
      const lower = addr.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push(addr)
    }
    return out
  }, [addresses])

  const results = useQueries({
    queries: uniqueAddresses.map((addr) => ({
      queryKey: ensQueryKey(addr),
      queryFn: () => resolveEnsName(provider!, addr),
      enabled: !!provider,
      staleTime: ENS_STALE_MS,
      gcTime: ENS_GC_MS,
      retry: 2,
    })),
  })

  // Serialize the resolution signal into a single string so the deps array
  // stays fixed-length across renders. `results` has one entry per address;
  // `dataUpdatedAt` ticks when a query settles.
  const resolutionSignal = useMemo(
    () =>
      results
        .map((r, i) => `${uniqueAddresses[i]?.toLowerCase() ?? ''}:${r.dataUpdatedAt}:${r.data ?? ''}`)
        .join('|'),
    [results, uniqueAddresses],
  )

  // Mirror successful resolutions into ensMapAtom so the resolve/displayName
  // callbacks below (and any legacy consumers) see the same data.
  useEffect(() => {
    const resolved = new Map<string, string>()
    for (let i = 0; i < uniqueAddresses.length; i++) {
      const result = results[i]
      const name = result?.data
      if (typeof name === 'string' && name.length > 0) {
        resolved.set(uniqueAddresses[i].toLowerCase(), name)
      }
    }
    if (resolved.size === 0) return
    setEnsMap((prev) => {
      let changed = false
      for (const [addr, name] of resolved) {
        if (prev.get(addr) !== name) {
          changed = true
          break
        }
      }
      if (!changed) return prev
      const next = new Map(prev)
      for (const [addr, name] of resolved) {
        next.set(addr, name)
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutionSignal, setEnsMap])

  const resolve = useCallback(
    (addr: string): string | null => {
      return ensMap.get(addr.toLowerCase()) ?? null
    },
    [ensMap],
  )

  const displayName = useCallback(
    (addr: string): string => {
      return ensMap.get(addr.toLowerCase()) ?? truncateAddress(addr)
    },
    [ensMap],
  )

  return { resolve, displayName }
}

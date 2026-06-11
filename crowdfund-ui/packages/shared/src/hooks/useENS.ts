// ABOUTME: ENS name resolution backed by react-query + IndexedDB cache.
// ABOUTME: Per-address queries dedupe across subscribers; 24h staleTime matches IDB TTL.

import { useEffect, useMemo, useCallback } from 'react'
import { atom, useAtom } from 'jotai'
import type { JsonRpcProvider } from 'ethers'
import { useQueries } from '@tanstack/react-query'
import { cacheENS, getCachedENSEntry } from '../lib/cache.js'
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

// Concurrency cap for reverse lookups so ~1,500 addresses don't fire as many
// simultaneous RPC calls (and get the keyless endpoint throttled). Cache hits
// don't count — only the actual `lookupAddress` calls are gated.
const MAX_CONCURRENT_LOOKUPS = 5
let activeLookups = 0
const lookupQueue: Array<() => void> = []

function pumpLookupQueue(): void {
  if (activeLookups >= MAX_CONCURRENT_LOOKUPS) return
  const job = lookupQueue.shift()
  if (!job) return
  activeLookups += 1
  job()
}

function withLookupLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    lookupQueue.push(() => {
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeLookups -= 1
          pumpLookupQueue()
        })
    })
    pumpLookupQueue()
  })
}

async function resolveEnsName(
  provider: JsonRpcProvider,
  address: string,
): Promise<string | null> {
  const lower = address.toLowerCase()
  // A cached entry (positive OR negative) short-circuits the RPC lookup.
  const cached = await getCachedENSEntry(lower)
  if (cached) return cached.name
  const name = await withLookupLimit(() => provider.lookupAddress(address))
  // Cache the result either way — negatives too, so we don't re-query every reload.
  await cacheENS(lower, name ?? null).catch(() => {})
  return name ?? null
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

  // `combine` lets react-query apply structural sharing to the derived value,
  // so `resolvedPairs` keeps a stable reference across renders until a new name
  // actually resolves — no per-render O(N) signal string to churn the effect.
  const resolvedPairs = useQueries({
    queries: uniqueAddresses.map((addr) => ({
      queryKey: ensQueryKey(addr),
      queryFn: () => resolveEnsName(provider!, addr),
      enabled: !!provider,
      staleTime: ENS_STALE_MS,
      gcTime: ENS_GC_MS,
      retry: 2,
    })),
    combine: (results) => {
      const pairs: Array<[string, string]> = []
      for (let i = 0; i < results.length; i += 1) {
        const name = results[i]?.data
        if (typeof name === 'string' && name.length > 0) {
          pairs.push([uniqueAddresses[i].toLowerCase(), name])
        }
      }
      return pairs
    },
  })

  // Mirror successful resolutions into ensMapAtom so the resolve/displayName
  // callbacks (and any legacy consumers) see the same data. Runs only when
  // `resolvedPairs` changes (stable across renders otherwise).
  useEffect(() => {
    if (resolvedPairs.length === 0) return
    setEnsMap((prev) => {
      let changed = false
      for (const [addr, name] of resolvedPairs) {
        if (prev.get(addr) !== name) {
          changed = true
          break
        }
      }
      if (!changed) return prev
      const next = new Map(prev)
      for (const [addr, name] of resolvedPairs) {
        next.set(addr, name)
      }
      return next
    })
  }, [resolvedPairs, setEnsMap])

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

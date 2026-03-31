// ABOUTME: ENS name resolution with IndexedDB caching.
// ABOUTME: Lazy resolution — batch-resolves addresses, caches results with 24h TTL.

import { useEffect, useRef, useCallback } from 'react'
import { atom, useAtom } from 'jotai'
import type { JsonRpcProvider } from 'ethers'
import { cacheENS, batchGetCachedENS } from '../lib/cache.js'
import { truncateAddress } from '../lib/format.js'

/** Map of address → ENS name */
export const ensMapAtom = atom<Map<string, string>>(new Map())

export interface UseENSConfig {
  provider: JsonRpcProvider | null
  addresses: string[]
}

export interface UseENSResult {
  resolve: (addr: string) => string | null
  displayName: (addr: string) => string
}

/**
 * Hook for lazy ENS resolution with caching.
 * Resolves addresses in batches, caches in IndexedDB with 24h TTL.
 */
export function useENS(config: UseENSConfig): UseENSResult {
  const { provider, addresses } = config
  const [ensMap, setEnsMap] = useAtom(ensMapAtom)
  const pendingRef = useRef(new Set<string>())

  useEffect(() => {
    if (!provider || addresses.length === 0) return

    let cancelled = false

    async function resolveAddresses() {
      if (!provider) return

      // Check cache first
      const cached = await batchGetCachedENS(addresses)
      if (cancelled) return

      if (cached.size > 0) {
        setEnsMap((prev) => {
          const next = new Map(prev)
          for (const [addr, name] of cached) {
            next.set(addr, name)
          }
          return next
        })
      }

      // Resolve uncached addresses (skip already pending ones)
      const toResolve = addresses.filter(
        (addr) =>
          !cached.has(addr.toLowerCase()) &&
          !pendingRef.current.has(addr.toLowerCase()),
      )

      for (const addr of toResolve) {
        pendingRef.current.add(addr.toLowerCase())
      }

      // Resolve in batches of 10 to avoid overwhelming the provider
      for (let i = 0; i < toResolve.length; i += 10) {
        if (cancelled) break
        const batch = toResolve.slice(i, i + 10)
        const results = await Promise.allSettled(
          batch.map((addr) => provider.lookupAddress(addr)),
        )

        if (cancelled) break

        const resolved = new Map<string, string>()
        for (let j = 0; j < batch.length; j++) {
          const result = results[j]
          if (result.status === 'fulfilled' && result.value) {
            resolved.set(batch[j].toLowerCase(), result.value)
            await cacheENS(batch[j], result.value).catch(() => {})
          }
          pendingRef.current.delete(batch[j].toLowerCase())
        }

        if (resolved.size > 0) {
          setEnsMap((prev) => {
            const next = new Map(prev)
            for (const [addr, name] of resolved) {
              next.set(addr, name)
            }
            return next
          })
        }
      }
    }

    resolveAddresses()

    return () => {
      cancelled = true
    }
  }, [provider, addresses, setEnsMap])

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

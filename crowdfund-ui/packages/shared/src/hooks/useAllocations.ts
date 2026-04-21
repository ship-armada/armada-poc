// ABOUTME: Prefetches computeAllocation() results for unclaimed participants post-finalization.
// ABOUTME: Uses react-query useQueries — dedupe + caching per address across subscribers.

import { useMemo } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { useQueries } from '@tanstack/react-query'
import { CROWDFUND_ABI_FRAGMENTS } from '../lib/constants.js'
import type { AddressSummary } from '../lib/graph.js'

/** Allocation data returned by computeAllocation() */
export interface PrefetchedAllocation {
  armAmount: bigint
  refundUsdc: bigint
}

export interface UseAllocationsConfig {
  provider: JsonRpcProvider | null
  contractAddress: string | null
  phase: number
  refundMode: boolean
  summaries: Map<string, AddressSummary>
}

/** Cache allocations for a long time — they're static post-finalization. */
const ALLOCATION_STALE_MS = 60 * 60 * 1000 // 1h
const ALLOCATION_GC_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * After finalization (phase === 1, not refundMode), prefetches theoretical
 * allocations for participants who have not yet claimed. Event-based allocation
 * data takes precedence — this hook only queries addresses where
 * summary.allocatedArm is null.
 */
export function useAllocations(config: UseAllocationsConfig): Map<string, PrefetchedAllocation> {
  const { provider, contractAddress, phase, refundMode, summaries } = config

  const active = phase === 1 && !refundMode && !!provider && !!contractAddress

  // Unclaimed addresses that still need a computeAllocation() read.
  // Stable reference unless the set of unclaimed addresses changes.
  const unclaimed = useMemo(() => {
    if (!active) return [] as string[]
    const out: string[] = []
    for (const [addr, summary] of summaries) {
      if (summary.allocatedArm === null) out.push(addr)
    }
    return out
  }, [active, summaries])

  // Memoised contract instance — same provider + address → same Contract.
  const contract = useMemo(() => {
    if (!provider || !contractAddress) return null
    return new Contract(contractAddress, CROWDFUND_ABI_FRAGMENTS, provider)
  }, [provider, contractAddress])

  const results = useQueries({
    queries: unclaimed.map((addr) => ({
      queryKey: ['crowdfundAllocation', contractAddress, addr],
      queryFn: async (): Promise<PrefetchedAllocation | null> => {
        if (!contract) return null
        try {
          const [armAmount, refundUsdc] = (await contract.computeAllocation(addr)) as [bigint, bigint]
          return { armAmount, refundUsdc }
        } catch {
          // Not a participant, or read reverted — skip silently (matches prior behavior).
          return null
        }
      },
      enabled: active && !!contract,
      staleTime: ALLOCATION_STALE_MS,
      gcTime: ALLOCATION_GC_MS,
      retry: 1,
    })),
  })

  // Serialise the settled signal into a single string so the memo deps stay
  // fixed-length across renders. dataUpdatedAt ticks when a query settles.
  const settledSignal = useMemo(
    () => results.map((r) => r.dataUpdatedAt).join(','),
    [results],
  )

  return useMemo(() => {
    const out = new Map<string, PrefetchedAllocation>()
    for (let i = 0; i < unclaimed.length; i++) {
      const data = results[i]?.data
      if (data) out.set(unclaimed[i], data)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unclaimed, settledSignal])
}

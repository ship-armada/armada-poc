// ABOUTME: Prefetches computeAllocation() results for unclaimed participants post-finalization.
// ABOUTME: Batches RPC calls in chunks of 50 and merges with event-based allocation data.

import { useEffect, useState, useRef } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
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

const BATCH_SIZE = 50

/**
 * After finalization (phase === 1, not refundMode), prefetches theoretical
 * allocations for participants who have not yet claimed. Event-based allocation
 * data takes precedence — this hook only queries addresses where
 * summary.allocatedArm is null.
 */
export function useAllocations(config: UseAllocationsConfig): Map<string, PrefetchedAllocation> {
  const { provider, contractAddress, phase, refundMode, summaries } = config
  const [allocations, setAllocations] = useState<Map<string, PrefetchedAllocation>>(new Map())
  const contractRef = useRef<Contract | null>(null)
  const fetchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Only activate post-finalization on the success path
    if (phase !== 1 || refundMode || !provider || !contractAddress) {
      return
    }

    // Find unclaimed addresses not yet fetched by this hook
    const unclaimed: string[] = []
    for (const [addr, summary] of summaries) {
      if (summary.allocatedArm === null && !fetchedRef.current.has(addr)) {
        unclaimed.push(addr)
      }
    }

    if (unclaimed.length === 0) return

    // Mark as fetched immediately to prevent duplicate requests
    for (const addr of unclaimed) {
      fetchedRef.current.add(addr)
    }

    if (!contractRef.current) {
      contractRef.current = new Contract(contractAddress, CROWDFUND_ABI_FRAGMENTS, provider)
    }
    const contract = contractRef.current

    async function fetchAllocations() {
      const results = new Map<string, PrefetchedAllocation>()

      // Process in batches
      for (let i = 0; i < unclaimed.length; i += BATCH_SIZE) {
        const batch = unclaimed.slice(i, i + BATCH_SIZE)
        const batchResults = await Promise.all(
          batch.map(async (addr) => {
            try {
              const [armAmount, refundUsdc] = await contract.computeAllocation(addr) as [bigint, bigint]
              return { addr, armAmount, refundUsdc }
            } catch {
              // Skip addresses that fail (e.g., not a participant)
              return null
            }
          }),
        )

        for (const result of batchResults) {
          if (result) {
            results.set(result.addr, {
              armAmount: result.armAmount,
              refundUsdc: result.refundUsdc,
            })
          }
        }
      }

      setAllocations((prev) => {
        const merged = new Map(prev)
        for (const [addr, alloc] of results) {
          merged.set(addr, alloc)
        }
        return merged
      })
    }

    fetchAllocations()
  }, [provider, contractAddress, phase, refundMode, summaries])

  // Reset when contract changes or phase goes back
  useEffect(() => {
    if (phase !== 1) {
      setAllocations(new Map())
      contractRef.current = null
      fetchedRef.current = new Set()
    }
  }, [phase, contractAddress])

  return allocations
}

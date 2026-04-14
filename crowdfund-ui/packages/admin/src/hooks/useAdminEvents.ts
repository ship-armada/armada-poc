// ABOUTME: Fetches crowdfund events for the admin event log.
// ABOUTME: In-memory array (no IndexedDB), polls every 10s, reverse-chronological.

import { useState, useEffect, useCallback, useRef } from 'react'
import type { JsonRpcProvider } from 'ethers'
import {
  fetchLogs,
  parseCrowdfundEvents,
  type CrowdfundEvent,
} from '@armada/crowdfund-shared'

export interface UseAdminEventsResult {
  events: CrowdfundEvent[]
  loading: boolean
  error: string | null
}

export function useAdminEvents(
  provider: JsonRpcProvider | null,
  contractAddress: string | null,
  startBlock: number = 0,
): UseAdminEventsResult {
  const [events, setEvents] = useState<CrowdfundEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastBlockRef = useRef<number>(startBlock)

  const refresh = useCallback(async () => {
    if (!provider || !contractAddress) return

    try {
      const currentBlock = await provider.getBlockNumber()
      const fromBlock = lastBlockRef.current > 0 ? lastBlockRef.current + 1 : startBlock

      if (fromBlock > currentBlock) return

      const logs = await fetchLogs(provider, contractAddress, fromBlock, currentBlock)
      const parsed = parseCrowdfundEvents(logs)

      if (parsed.length > 0) {
        setEvents((prev) => {
          const combined = [...prev, ...parsed]
          // Keep last 500 events, reverse-chronological
          combined.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
          return combined.slice(0, 500)
        })
      }

      lastBlockRef.current = currentBlock
      setLoading(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch events')
      setLoading(false)
    }
  }, [provider, contractAddress])

  useEffect(() => {
    if (!provider || !contractAddress) return

    lastBlockRef.current = startBlock
    setEvents([])
    refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [provider, contractAddress, refresh])

  return { events, loading, error }
}

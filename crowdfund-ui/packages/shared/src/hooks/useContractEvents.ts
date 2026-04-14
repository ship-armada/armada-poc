// ABOUTME: Event fetching pipeline with polling and IndexedDB caching.
// ABOUTME: Fetches historical events on mount, then polls for new events on an interval.

import { useEffect, useRef } from 'react'
import { atom, useAtom } from 'jotai'
import type { JsonRpcProvider } from 'ethers'
import { fetchLogs } from '../lib/rpc.js'
import { parseCrowdfundEvents } from '../lib/events.js'
import { getCachedEvents, cacheEvents } from '../lib/cache.js'
import type { CrowdfundEvent } from '../lib/events.js'

/** Atom holding all fetched events, oldest first */
export const crowdfundEventsAtom = atom<CrowdfundEvent[]>([])

/** Last block number that was fetched */
export const lastFetchedBlockAtom = atom<number>(0)

/** Whether the initial event load is still in progress */
export const eventsLoadingAtom = atom<boolean>(true)

/** Error message from event fetching, if any */
export const eventsErrorAtom = atom<string | null>(null)

export interface UseContractEventsConfig {
  provider: JsonRpcProvider | null
  contractAddress: string | null
  pollIntervalMs: number
  /** Block number to start fetching from (e.g. contract deploy block). Defaults to 0. */
  startBlock?: number
}

export interface UseContractEventsResult {
  events: CrowdfundEvent[]
  loading: boolean
  error: string | null
}

/**
 * Hook that fetches crowdfund events from the blockchain.
 * On mount: loads cached events from IndexedDB, then fetches new events since last block.
 * Polls for new events on the configured interval.
 */
export function useContractEvents(config: UseContractEventsConfig): UseContractEventsResult {
  const { provider, contractAddress, pollIntervalMs, startBlock = 0 } = config
  const [events, setEvents] = useAtom(crowdfundEventsAtom)
  const [, setLastBlock] = useAtom(lastFetchedBlockAtom)
  const [loading, setLoading] = useAtom(eventsLoadingAtom)
  const [error, setError] = useAtom(eventsErrorAtom)
  const lastBlockRef = useRef(startBlock)

  useEffect(() => {
    if (!provider || !contractAddress) return

    let cancelled = false
    let intervalId: ReturnType<typeof setInterval> | null = null

    async function fetchNewEvents() {
      if (!provider || !contractAddress) return
      try {
        const fromBlock = lastBlockRef.current + 1
        const rawLogs = await fetchLogs(provider, contractAddress, fromBlock, 'latest')
        const newEvents = parseCrowdfundEvents(rawLogs)

        if (cancelled) return

        if (newEvents.length > 0) {
          const latestBlock = Math.max(...newEvents.map((e) => e.blockNumber))
          lastBlockRef.current = latestBlock
          setLastBlock(latestBlock)

          setEvents((prev) => {
            // Dedup by txHash + logIndex
            const existing = new Set(prev.map((e) => `${e.transactionHash}-${e.logIndex}`))
            const unique = newEvents.filter(
              (e) => !existing.has(`${e.transactionHash}-${e.logIndex}`),
            )
            if (unique.length === 0) return prev
            return [...prev, ...unique]
          })

          // Persist to IndexedDB
          await cacheEvents(newEvents, latestBlock).catch(() => {
            // IndexedDB errors are non-fatal
          })
        } else {
          // Even if no events, update lastBlock to current
          const currentBlock = await provider.getBlockNumber()
          if (!cancelled) {
            lastBlockRef.current = currentBlock
            setLastBlock(currentBlock)
          }
        }

        if (!cancelled) setError(null)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch events')
        }
      }
    }

    async function initialize() {
      try {
        // Load from IndexedDB cache first
        const cached = await getCachedEvents()
        if (cancelled) return

        if (cached.events.length > 0) {
          setEvents(cached.events)
          lastBlockRef.current = Math.max(cached.lastBlock, startBlock)
          setLastBlock(cached.lastBlock)
        }

        // Fetch new events since cache
        await fetchNewEvents()
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize events')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    initialize()

    // Poll for new events
    intervalId = setInterval(fetchNewEvents, pollIntervalMs)

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [provider, contractAddress, pollIntervalMs, setEvents, setLastBlock, setLoading, setError])

  return { events, loading, error }
}

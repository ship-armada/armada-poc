// ABOUTME: Event fetching pipeline with polling and IndexedDB caching.
// ABOUTME: Backed by react-query; IDB seeds initial data, cursor is stored in query data.

import { useEffect, useMemo } from 'react'
import { atom, useSetAtom } from 'jotai'
import type { JsonRpcProvider } from 'ethers'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLogs } from '../lib/rpc.js'
import { parseCrowdfundEvents } from '../lib/events.js'
import { getCachedEvents, cacheEvents } from '../lib/cache.js'
import type { CrowdfundEvent } from '../lib/events.js'

/** Atom holding all fetched events, oldest first — mirrored from query data for non-hook consumers (useGraphState). */
export const crowdfundEventsAtom = atom<CrowdfundEvent[]>([])

/** Last block number that was fetched. Mirrored for legacy consumers. */
export const lastFetchedBlockAtom = atom<number>(0)

/** Whether the initial event load is still in progress. Mirrored for legacy consumers. */
export const eventsLoadingAtom = atom<boolean>(true)

/** Error message from event fetching, if any. Mirrored for legacy consumers. */
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

interface EventsSnapshot {
  events: CrowdfundEvent[]
  cursor: number
}

const EMPTY_EVENTS: CrowdfundEvent[] = []

function dedupEventKey(e: CrowdfundEvent): string {
  return `${e.transactionHash}-${e.logIndex}`
}

/**
 * Hook that fetches crowdfund events from the blockchain.
 * On mount: loads cached events from IndexedDB via the query's initial fetch.
 * Then polls for new events on the configured interval, extending the cursor.
 */
export function useContractEvents(config: UseContractEventsConfig): UseContractEventsResult {
  const { provider, contractAddress, pollIntervalMs, startBlock } = config
  const effectiveStartBlock = startBlock ?? 0

  const setEventsAtom = useSetAtom(crowdfundEventsAtom)
  const setLastBlockAtom = useSetAtom(lastFetchedBlockAtom)
  const setLoadingAtom = useSetAtom(eventsLoadingAtom)
  const setErrorAtom = useSetAtom(eventsErrorAtom)

  const queryClient = useQueryClient()

  // queryKey is stable per contract address + start block. Cursor lives inside
  // query data so it survives refetches without a parallel ref.
  const queryKey = useMemo(
    () => ['crowdfundEvents', contractAddress, effectiveStartBlock] as const,
    [contractAddress, effectiveStartBlock],
  )

  const query = useQuery<EventsSnapshot, Error>({
    queryKey,
    queryFn: async () => {
      if (!provider || !contractAddress) {
        return { events: EMPTY_EVENTS, cursor: effectiveStartBlock }
      }

      let prior = queryClient.getQueryData<EventsSnapshot>(queryKey)
      if (prior === undefined) {
        // First run — seed cursor + events from IndexedDB.
        const cached = await getCachedEvents().catch(() => ({
          events: [] as CrowdfundEvent[],
          lastBlock: 0,
        }))
        prior = {
          events: cached.events,
          cursor: Math.max(cached.lastBlock, effectiveStartBlock),
        }
      }

      const rawLogs = await fetchLogs(provider, contractAddress, prior.cursor + 1, 'latest')
      const newEvents = parseCrowdfundEvents(rawLogs)

      if (newEvents.length === 0) {
        // Advance cursor to current block to avoid re-scanning — matches prior behavior.
        const currentBlock = await provider.getBlockNumber()
        return { events: prior.events, cursor: currentBlock }
      }

      // Dedup by txHash + logIndex against prior events.
      const existing = new Set(prior.events.map(dedupEventKey))
      const unique = newEvents.filter((e) => !existing.has(dedupEventKey(e)))
      const merged = unique.length === 0 ? prior.events : [...prior.events, ...unique]
      const latestBlock = Math.max(...newEvents.map((e) => e.blockNumber))

      // Persist to IndexedDB (non-fatal on failure).
      cacheEvents(newEvents, latestBlock).catch(() => {})

      return { events: merged, cursor: latestBlock }
    },
    enabled: !!provider && !!contractAddress,
    refetchInterval: pollIntervalMs,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 30 * 60 * 1000,
    retry: false,
  })

  const events = query.data?.events ?? EMPTY_EVENTS
  const loading = query.isPending
  const errorMessage = query.error
    ? query.error instanceof Error
      ? query.error.message
      : 'Failed to fetch events'
    : null

  // Mirror into legacy atoms — useGraphState reads crowdfundEventsAtom, and the
  // others are part of the shared barrel's public surface.
  useEffect(() => {
    setEventsAtom(events)
  }, [events, setEventsAtom])

  useEffect(() => {
    if (query.data) setLastBlockAtom(query.data.cursor)
  }, [query.data, setLastBlockAtom])

  useEffect(() => {
    setLoadingAtom(loading)
  }, [loading, setLoadingAtom])

  useEffect(() => {
    setErrorAtom(errorMessage)
  }, [errorMessage, setErrorAtom])

  return { events, loading, error: errorMessage }
}

// ABOUTME: Event fetching pipeline with polling and IndexedDB caching.
// ABOUTME: Backed by react-query; IDB seeds initial data, cursor is stored in query data.

import { useCallback, useEffect, useMemo } from 'react'
import { atom, useSetAtom } from 'jotai'
import type { JsonRpcProvider } from 'ethers'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLogs } from '../lib/rpc.js'
import { parseCrowdfundEvents } from '../lib/events.js'
import { getCachedEvents, cacheEvents } from '../lib/cache.js'
import { fetchIndexedEventsSnapshot, fetchIndexerHealth } from '../lib/indexer.js'
import type { CrowdfundEvent } from '../lib/events.js'
import type { IndexerHealth } from '../lib/indexer.js'

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
  /** Optional indexer API base URL. When provided, Sepolia loads use indexed snapshots before RPC fallback. */
  indexerBaseUrl?: string | null
}

export interface UseContractEventsResult {
  events: CrowdfundEvent[]
  loading: boolean
  error: string | null
  indexerHealth: IndexerHealth | null
  ingestReceiptLogs: (logs: readonly ReceiptLogLike[]) => void
}

interface EventsSnapshot {
  events: CrowdfundEvent[]
  cursor: number
}

export interface ReceiptLogLike {
  blockNumber?: number
  transactionHash?: string
  index?: number
  logIndex?: number
  topics: readonly string[]
  data: string
}

const EMPTY_EVENTS: CrowdfundEvent[] = []

function dedupEventKey(e: CrowdfundEvent): string {
  return `${e.transactionHash}-${e.logIndex}`
}

function toRawReceiptLog(log: ReceiptLogLike) {
  return {
    blockNumber: log.blockNumber ?? 0,
    transactionHash: log.transactionHash ?? '',
    logIndex: log.logIndex ?? log.index ?? 0,
    topics: [...log.topics],
    data: log.data,
  }
}

/**
 * Hook that fetches crowdfund events from the blockchain.
 * On mount: loads cached events from IndexedDB via the query's initial fetch.
 * Then polls for new events on the configured interval, extending the cursor.
 */
export function useContractEvents(config: UseContractEventsConfig): UseContractEventsResult {
  const { provider, contractAddress, pollIntervalMs, startBlock, indexerBaseUrl } = config
  const effectiveStartBlock = startBlock ?? 0

  const setEventsAtom = useSetAtom(crowdfundEventsAtom)
  const setLastBlockAtom = useSetAtom(lastFetchedBlockAtom)
  const setLoadingAtom = useSetAtom(eventsLoadingAtom)
  const setErrorAtom = useSetAtom(eventsErrorAtom)

  const queryClient = useQueryClient()

  // queryKey is stable per contract address + start block. Cursor lives inside
  // query data so it survives refetches without a parallel ref.
  const queryKey = useMemo(
    () => ['crowdfundEvents', contractAddress, effectiveStartBlock, indexerBaseUrl ?? null] as const,
    [contractAddress, effectiveStartBlock, indexerBaseUrl],
  )

  const query = useQuery<EventsSnapshot, Error>({
    queryKey,
    queryFn: async () => {
      if (!provider || !contractAddress) {
        return { events: EMPTY_EVENTS, cursor: effectiveStartBlock }
      }

      let prior = queryClient.getQueryData<EventsSnapshot>(queryKey)
      if (prior === undefined) {
        if (indexerBaseUrl) {
          try {
            const indexed = await fetchIndexedEventsSnapshot(indexerBaseUrl)
            if (
              indexed.metadata.contractAddress.toLowerCase() === contractAddress.toLowerCase() &&
              indexed.metadata.deployBlock === effectiveStartBlock
            ) {
              cacheEvents(indexed.events, indexed.metadata.verifiedBlock).catch(() => {})
              return {
                events: indexed.events,
                cursor: indexed.metadata.verifiedBlock,
              }
            }
          } catch {
            // Fall back to the existing RPC/IndexedDB path when the indexer is unavailable.
          }
        }

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

  const healthQuery = useQuery<IndexerHealth, Error>({
    queryKey: ['crowdfundIndexerHealth', indexerBaseUrl],
    queryFn: () => fetchIndexerHealth(indexerBaseUrl!),
    enabled: !!indexerBaseUrl,
    refetchInterval: pollIntervalMs,
    refetchIntervalInBackground: false,
    staleTime: pollIntervalMs,
    retry: false,
  })

  const ingestReceiptLogs = useCallback(
    (logs: readonly ReceiptLogLike[]) => {
      const receiptEvents = parseCrowdfundEvents(logs.map(toRawReceiptLog))
      if (receiptEvents.length === 0) return

      queryClient.setQueryData<EventsSnapshot>(queryKey, (prior) => {
        const existing = new Set((prior?.events ?? []).map(dedupEventKey))
        const unique = receiptEvents.filter((event) => !existing.has(dedupEventKey(event)))
        if (unique.length === 0) return prior
        const merged = [...(prior?.events ?? []), ...unique].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
        const latestBlock = Math.max(prior?.cursor ?? effectiveStartBlock, ...unique.map((event) => event.blockNumber))
        cacheEvents(unique, latestBlock).catch(() => {})
        return { events: merged, cursor: latestBlock }
      })
    },
    [effectiveStartBlock, queryClient, queryKey],
  )

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

  return {
    events,
    loading,
    error: errorMessage,
    indexerHealth: healthQuery.data ?? null,
    ingestReceiptLogs,
  }
}

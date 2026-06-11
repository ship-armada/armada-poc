// ABOUTME: Event fetching pipeline with polling and IndexedDB caching.
// ABOUTME: Backed by react-query; IDB seeds initial data, cursor is stored in query data.

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  /** Chain id of the deployment. Used to namespace the IndexedDB event cache so
   *  switching networks/contracts can't mix histories. Defaults to 0 when unset. */
  chainId?: number
  /** Max blocks per eth_getLogs request during backfill. Defaults to the rpc
   *  module's conservative default; pass a wider value for capable RPCs. */
  maxBlockRange?: number
  /** Optional indexer API base URL. When provided, Sepolia loads use indexed snapshots before RPC fallback. */
  indexerBaseUrl?: string | null
}

/** Coarse cold-start backfill progress, for a "syncing history" UI line. */
export interface BackfillProgress {
  active: boolean
  fromBlock: number
  currentBlock: number
  toBlock: number
}

export interface UseContractEventsResult {
  events: CrowdfundEvent[]
  loading: boolean
  error: string | null
  indexerHealth: IndexerHealth | null
  ingestReceiptLogs: (logs: readonly ReceiptLogLike[]) => void
  /** Non-null while a multi-chunk cold-start backfill is in progress. */
  backfill: BackfillProgress | null
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

/**
 * Merge freshly polled events into the current snapshot. Dedups against the
 * current events and advances the cursor to the resolved scan upper bound —
 * never backwards, and never past what was actually scanned. Returns the new
 * snapshot plus the unique (newly added) events so the caller can persist them.
 */
export function mergePolledEvents(
  current: EventsSnapshot,
  newEvents: CrowdfundEvent[],
  resolvedTo: number,
): { snapshot: EventsSnapshot; unique: CrowdfundEvent[] } {
  const existing = new Set(current.events.map(dedupEventKey))
  const unique = newEvents.filter((e) => !existing.has(dedupEventKey(e)))
  const events = unique.length === 0 ? current.events : [...current.events, ...unique]
  const cursor = Math.max(current.cursor, resolvedTo)
  return { snapshot: { events, cursor }, unique }
}

/**
 * Merge receipt-derived events into the prior snapshot WITHOUT advancing the
 * cursor: re-fetching those blocks is idempotent (dedup), and advancing here
 * would skip other participants' events between the cursor and the receipt
 * block. Returns the new snapshot plus the unique events.
 */
export function mergeReceiptEvents(
  prior: EventsSnapshot | undefined,
  receiptEvents: CrowdfundEvent[],
  startBlock: number,
): { snapshot: EventsSnapshot; unique: CrowdfundEvent[] } {
  const priorEvents = prior?.events ?? []
  const existing = new Set(priorEvents.map(dedupEventKey))
  const unique = receiptEvents.filter((e) => !existing.has(dedupEventKey(e)))
  const events = [...priorEvents, ...unique].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  )
  const cursor = prior?.cursor ?? startBlock
  return { snapshot: { events, cursor }, unique }
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
  const { provider, contractAddress, pollIntervalMs, startBlock, chainId, maxBlockRange, indexerBaseUrl } = config
  const effectiveStartBlock = startBlock ?? 0
  const effectiveChainId = chainId ?? 0

  const [backfill, setBackfill] = useState<BackfillProgress | null>(null)

  const setEventsAtom = useSetAtom(crowdfundEventsAtom)
  const setLastBlockAtom = useSetAtom(lastFetchedBlockAtom)
  const setLoadingAtom = useSetAtom(eventsLoadingAtom)
  const setErrorAtom = useSetAtom(eventsErrorAtom)

  const queryClient = useQueryClient()

  // queryKey is stable per contract address + start block. Cursor lives inside
  // query data so it survives refetches without a parallel ref.
  const queryKey = useMemo(
    () =>
      ['crowdfundEvents', effectiveChainId, contractAddress, effectiveStartBlock, indexerBaseUrl ?? null] as const,
    [effectiveChainId, contractAddress, effectiveStartBlock, indexerBaseUrl],
  )

  const query = useQuery<EventsSnapshot, Error>({
    queryKey,
    queryFn: async () => {
      if (!provider || !contractAddress) {
        return { events: EMPTY_EVENTS, cursor: effectiveStartBlock }
      }

      const deployment = { chainId: effectiveChainId, contractAddress }

      let prior = queryClient.getQueryData<EventsSnapshot>(queryKey)
      if (prior === undefined) {
        if (indexerBaseUrl) {
          try {
            const indexed = await fetchIndexedEventsSnapshot(indexerBaseUrl)
            // Accept any snapshot whose backfill window CONTAINS our needed start
            // block — snapshot.deployBlock <= effectiveStartBlock. Snapshots starting
            // earlier than effectiveStartBlock are harmless (they just include a few
            // pre-contract-creation blocks with zero matching logs). Strict equality
            // here is fragile: the indexer env, the deployments-repo manifest, and
            // the frontend bundle are three independently-edited copies of the same
            // value, and any drift silently disables the snapshot path.
            const addressMatches =
              indexed.metadata.contractAddress.toLowerCase() === contractAddress.toLowerCase()
            const startBlockCovered = indexed.metadata.deployBlock <= effectiveStartBlock
            if (addressMatches && startBlockCovered) {
              cacheEvents(indexed.events, indexed.metadata.verifiedBlock, deployment).catch(() => {})
              return {
                events: indexed.events,
                cursor: indexed.metadata.verifiedBlock,
              }
            }
            // Mismatch — surface why we're skipping the snapshot. Silent fallback
            // here masked a stale deploys-repo manifest in medi3.
            console.warn(
              '[useContractEvents] indexer snapshot rejected, falling back to RPC',
              {
                snapshotContractAddress: indexed.metadata.contractAddress,
                expectedContractAddress: contractAddress,
                snapshotDeployBlock: indexed.metadata.deployBlock,
                effectiveStartBlock,
                addressMatches,
                startBlockCovered,
              },
            )
          } catch (err) {
            console.warn(
              '[useContractEvents] indexer snapshot fetch failed, falling back to RPC',
              err,
            )
          }
        }

        // First run — seed cursor + events from IndexedDB.
        const cached = await getCachedEvents(deployment).catch(() => ({
          events: [] as CrowdfundEvent[],
          lastBlock: 0,
        }))
        prior = {
          events: cached.events,
          cursor: Math.max(cached.lastBlock, effectiveStartBlock),
        }
      }

      const fromBlock = prior.cursor + 1
      const { logs: rawLogs, resolvedTo } = await fetchLogs(
        provider,
        contractAddress,
        fromBlock,
        'latest',
        {
          maxBlockRange,
          onChunk: ({ logs: chunkLogs, toBlock, scannedTo }) => {
            // Persist each chunk + its cursor as the scan proceeds so an
            // interrupted backfill resumes from here (idempotent put).
            const chunkEvents = parseCrowdfundEvents(chunkLogs)
            cacheEvents(chunkEvents, scannedTo, deployment).catch(() => {})
            // Only surface progress for a genuine multi-chunk backfill, not the
            // 1-block deltas a normal poll scans.
            if (toBlock - fromBlock > (maxBlockRange ?? 0)) {
              setBackfill({ active: true, fromBlock, currentBlock: scannedTo, toBlock })
            }
          },
        },
      )
      setBackfill(null)
      const newEvents = parseCrowdfundEvents(rawLogs)

      // Merge against the CURRENT query data at resolution time — not the
      // snapshot captured at fetch start — so an in-flight ingestReceiptLogs
      // update isn't wiped by this poll. The cursor comes from resolvedTo (the
      // range we actually scanned), not a second getBlockNumber() call.
      const current = queryClient.getQueryData<EventsSnapshot>(queryKey) ?? prior
      const { snapshot, unique } = mergePolledEvents(current, newEvents, resolvedTo)

      // Persist new events + the advanced cursor (idempotent put). Persisting on
      // every poll — even with zero new events — lets an interrupted backfill
      // resume from the cursor rather than restart.
      cacheEvents(unique, snapshot.cursor, deployment).catch(() => {})

      return snapshot
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
      if (!contractAddress) return
      const receiptEvents = parseCrowdfundEvents(logs.map(toRawReceiptLog))
      if (receiptEvents.length === 0) return

      const deployment = { chainId: effectiveChainId, contractAddress }

      queryClient.setQueryData<EventsSnapshot>(queryKey, (prior) => {
        const { snapshot, unique } = mergeReceiptEvents(prior, receiptEvents, effectiveStartBlock)
        if (unique.length === 0) return prior
        // Persist the new events but keep the cursor where it was (snapshot.cursor
        // is prior's cursor) so the next poll still re-scans the interim range.
        cacheEvents(unique, snapshot.cursor, deployment).catch(() => {})
        return snapshot
      })
    },
    [contractAddress, effectiveChainId, effectiveStartBlock, queryClient, queryKey],
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

  // A failed/aborted scan must not leave a stale "syncing" indicator up.
  useEffect(() => {
    if (query.isError) setBackfill(null)
  }, [query.isError])

  return {
    events,
    loading,
    error: errorMessage,
    indexerHealth: healthQuery.data ?? null,
    ingestReceiptLogs,
    backfill,
  }
}

// ABOUTME: Fetches crowdfund events for the admin event log.
// ABOUTME: Prefers an indexer snapshot when configured; otherwise backfills + polls direct from RPC.

import { useState, useEffect, useCallback, useRef } from 'react'
import type { JsonRpcProvider } from 'ethers'
import {
  fetchLogs,
  fetchIndexedEventsSnapshot,
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
  indexerBaseUrl: string | null = null,
): UseAdminEventsResult {
  const [events, setEvents] = useState<CrowdfundEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastBlockRef = useRef<number>(startBlock)
  // True once we have either an indexer snapshot or a first successful RPC backfill.
  // While false, polling backfills from `startBlock`; once true, polling backfills
  // incrementally from `lastBlockRef + 1`.
  const seededRef = useRef<boolean>(false)

  const refresh = useCallback(async () => {
    if (!provider || !contractAddress) return

    try {
      const currentBlock = await provider.getBlockNumber()
      const fromBlock = seededRef.current ? lastBlockRef.current + 1 : startBlock

      if (fromBlock > currentBlock) {
        lastBlockRef.current = currentBlock
        setLoading(false)
        return
      }

      const logs = await fetchLogs(provider, contractAddress, fromBlock, currentBlock)
      const parsed = parseCrowdfundEvents(logs)

      if (parsed.length > 0) {
        setEvents((prev) => {
          // Dedup by txHash + logIndex — a snapshot seed plus a polling tick that
          // overlaps the same range would otherwise double-count events.
          const seen = new Set(prev.map((e) => `${e.transactionHash}:${e.logIndex}`))
          const merged = [...prev]
          for (const e of parsed) {
            const key = `${e.transactionHash}:${e.logIndex}`
            if (!seen.has(key)) {
              seen.add(key)
              merged.push(e)
            }
          }
          merged.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
          return merged.slice(0, 500)
        })
      }

      lastBlockRef.current = currentBlock
      seededRef.current = true
      setLoading(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch events')
      setLoading(false)
    }
  }, [provider, contractAddress, startBlock])

  useEffect(() => {
    if (!provider || !contractAddress) return

    let cancelled = false
    lastBlockRef.current = startBlock
    seededRef.current = false
    setEvents([])
    setLoading(true)

    const init = async () => {
      // Snapshot path: try to seed from the indexer before falling back to RPC.
      // Mirrors `useContractEvents` in the committer — the same drift guards apply.
      if (indexerBaseUrl) {
        try {
          const snapshot = await fetchIndexedEventsSnapshot(indexerBaseUrl)
          if (cancelled) return
          const addressMatches =
            snapshot.metadata.contractAddress.toLowerCase() === contractAddress.toLowerCase()
          // Accept snapshots whose backfill window CONTAINS startBlock; an
          // earlier-starting snapshot is harmless (extra empty blocks).
          const startBlockCovered = snapshot.metadata.deployBlock <= startBlock
          if (addressMatches && startBlockCovered) {
            const sorted = [...snapshot.events].sort(
              (a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex,
            )
            setEvents(sorted.slice(0, 500))
            lastBlockRef.current = snapshot.metadata.verifiedBlock
            seededRef.current = true
            setLoading(false)
          } else {
            console.warn(
              '[useAdminEvents] indexer snapshot rejected, falling back to RPC',
              {
                snapshotContractAddress: snapshot.metadata.contractAddress,
                expectedContractAddress: contractAddress,
                snapshotDeployBlock: snapshot.metadata.deployBlock,
                effectiveStartBlock: startBlock,
                addressMatches,
                startBlockCovered,
              },
            )
          }
        } catch (err) {
          console.warn(
            '[useAdminEvents] indexer snapshot fetch failed, falling back to RPC',
            err,
          )
        }
      }
      if (cancelled) return
      // Always start polling — incremental from `lastBlockRef + 1` when the
      // snapshot seeded us, or a full backfill from `startBlock` otherwise.
      refresh()
    }

    init()
    const id = setInterval(refresh, 10_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [provider, contractAddress, indexerBaseUrl, startBlock, refresh])

  return { events, loading, error }
}

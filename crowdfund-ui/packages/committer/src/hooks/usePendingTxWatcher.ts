// ABOUTME: Watches persisted pending txs via the fallback provider, resolving them after a reload (or post-timeout).
// ABOUTME: Surfaces a list for the wallet-pill chip and fires onResolved (e.g. refresh allowance) when a tx lands.

import { useEffect, useRef, useState } from 'react'
import type { JsonRpcProvider } from 'ethers'
import { loadPendingTxs, removePendingTx } from '@/lib/pendingTx'

export type WatchedTxStatus = 'pending' | 'confirmed' | 'failed'

export interface WatchedTx {
  txHash: string
  label: string
  status: WatchedTxStatus
}

const RESCAN_MS = 4000

/**
 * Resume-watch persisted pending txs for `chainId` via the fallback `provider`
 * (not the wallet transport). Re-scans periodically so txs persisted mid-session
 * (e.g. a `tx.wait` timeout) are picked up too. On resolution a tx is dropped
 * from storage and `onResolved` fires (refresh balances/allowance). Returns the
 * watched list (pending + this session's resolved) for the pending-tx chip.
 */
export function usePendingTxWatcher(
  provider: JsonRpcProvider | null,
  chainId: number,
  onResolved?: () => void,
): WatchedTx[] {
  const [watched, setWatched] = useState<WatchedTx[]>([])
  // Hashes already being awaited, so a re-scan doesn't double-watch.
  const watchingRef = useRef<Set<string>>(new Set())
  // Held in a ref so an unstable `onResolved` identity doesn't tear down and
  // restart the watch loop (which could strand an in-flight waitForTransaction).
  const onResolvedRef = useRef(onResolved)
  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  useEffect(() => {
    if (!provider) return
    let cancelled = false

    const scan = () => {
      const pending = loadPendingTxs().filter((t) => t.chainId === chainId)

      // Surface any newly-seen pending tx as 'pending'.
      setWatched((prev) => {
        const known = new Set(prev.map((w) => w.txHash))
        const additions = pending
          .filter((t) => !known.has(t.txHash))
          .map((t): WatchedTx => ({ txHash: t.txHash, label: t.label, status: 'pending' }))
        return additions.length ? [...prev, ...additions] : prev
      })

      for (const t of pending) {
        if (watchingRef.current.has(t.txHash)) continue
        watchingRef.current.add(t.txHash)
        provider
          .waitForTransaction(t.txHash)
          .then((receipt) => {
            if (cancelled) return
            const status: WatchedTxStatus = receipt && receipt.status === 1 ? 'confirmed' : 'failed'
            setWatched((prev) =>
              prev.map((w) => (w.txHash === t.txHash ? { ...w, status } : w)),
            )
            removePendingTx(t.txHash)
            onResolvedRef.current?.()
          })
          .catch(() => {
            // Transient RPC failure — drop the watch guard so a later scan retries.
            if (!cancelled) watchingRef.current.delete(t.txHash)
          })
      }
    }

    scan()
    const id = setInterval(scan, RESCAN_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [provider, chainId])

  return watched
}

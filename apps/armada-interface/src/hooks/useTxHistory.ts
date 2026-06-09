// ABOUTME: Hydrates txListAtom from IDB on the active wallet's first render and re-hydrates when the active walletId changes (V2 Phase 6 scoping).
// ABOUTME: Single source for "all tx records belonging to the currently-active shielded wallet on this device".

import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { activeRailgunWalletIdAtom } from '@/state/wallet'
import { txListAtom, upsertTxAtom } from '@/state/tx'
import { loadAllTx } from '@/lib/tx/storage'
import { track, trackError } from '@/lib/telemetry'

export function useTxHistory() {
  const list = useAtomValue(txListAtom)
  const setList = useSetAtom(txListAtom)
  const upsert = useSetAtom(upsertTxAtom)
  const activeWalletId = useAtomValue(activeRailgunWalletIdAtom)

  useEffect(() => {
    let cancelled = false
    // Phase 6 scoping: reset the atom on every walletId change BEFORE hydrating. Without this,
    // switching from wallet A → wallet B would leave A's records lingering in the atom and the
    // activeTxListAtom filter would be the only thing keeping them off-screen. We want the
    // physical reset too — defense in depth, plus it lets a wallet-agnostic consumer of
    // `txListAtom` (executor cold-load probe) see clean state for the active wallet.
    setList([])

    if (!activeWalletId) {
      // No active wallet (locked / never-unlocked). The reset above is the operation; we don't
      // touch IDB so we don't accidentally surface stale records.
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      try {
        const records = await loadAllTx(activeWalletId)
        if (cancelled) return
        // Merge into the atom rather than overwriting. If the executor's resume path wrote a
        // record while we were awaiting the IDB read, a wholesale replace would drop it.
        // `upsertTxAtom` enforces OCC via `updatedSeq`, so seeding older IDB records can't
        // regress anything newer that already lives in memory.
        for (const r of records) upsert(r)
        track('tx.history.hydrated', { count: records.length })
      } catch (err) {
        trackError('useTxHistory.hydrate', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeWalletId, setList, upsert])

  return { list }
}

// ABOUTME: Hydrates txListAtom from IDB whenever the active wallet's id changes OR its lock status flips to unlocked (V2 Phase 6 scoping). The status dep is critical — without it, a cold-load with a cached walletId in the atom but no decryption key in the keyManager produces a hydrated count of zero, and the effect never re-fires when sign-in unlocks the wallet.
// ABOUTME: Single source for "all tx records belonging to the currently-active shielded wallet on this device".

import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { activeShieldedWalletAtom } from '@/state/wallet'
import { txListAtom, upsertTxAtom } from '@/state/tx'
import { loadAllTx } from '@/lib/tx/storage'
import { track, trackError } from '@/lib/telemetry'

export function useTxHistory(): void {
  // Hydrator only — deliberately does NOT subscribe to txListAtom (P1-19). This hook is mounted at
  // the App root; subscribing would re-render the whole app shell on every tx write (≈10 proof-
  // progress writes land while snarkjs saturates the main thread). Components that DISPLAY the list
  // (History page, RecentActivityCard) subscribe to activeTxListAtom themselves.
  const setList = useSetAtom(txListAtom)
  const upsert = useSetAtom(upsertTxAtom)
  // Reading the full active-wallet object lets us re-run on lock-status flips, not just on
  // walletId changes. `loadAllTx` requires `keyManager.isUnlocked()` to decrypt the AES-GCM
  // envelopes; if the effect only ran on `id` change, a refresh that restores a cached id
  // before sign-in would call `loadAllTx` while locked, return [], and never re-fire when
  // unlock completes (id stays the same → no dep change → no rehydrate).
  const active = useAtomValue(activeShieldedWalletAtom)
  const activeWalletId = active?.id ?? null
  const activeStatus = active?.status ?? null

  useEffect(() => {
    let cancelled = false
    // Phase 6 scoping: reset the atom on every walletId change BEFORE hydrating. Without this,
    // switching from wallet A → wallet B would leave A's records lingering in the atom and the
    // activeTxListAtom filter would be the only thing keeping them off-screen. We want the
    // physical reset too — defense in depth, plus it lets a wallet-agnostic consumer of
    // `txListAtom` (executor cold-load probe) see clean state for the active wallet.
    setList([])

    // Only hydrate when the wallet is unlocked. While locked, `loadAllTx` returns [] (no
    // historyEncryptionKey to AES-GCM-decrypt envelopes); running anyway is wasted work and
    // would emit a misleading `count: 0` telemetry event.
    if (!activeWalletId || activeStatus !== 'unlocked') {
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
  }, [activeWalletId, activeStatus, setList, upsert])
}

// ABOUTME: Bridges lib/railgun/sync's SDK balance events into shieldedUsdcAtom + yieldSharesAtom; drives an initial scan on unlock.
// ABOUTME: Mount once at App root. No-op when locked; auto-resubscribes on unlock.

import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeShieldedWalletAtom,
  shieldedUsdcAtom,
  syncRetryEpochAtom,
  syncStateAtom,
  yieldSharesAtom,
} from '@/state/wallet'
import {
  refreshShieldedBalances,
  subscribeBalanceUpdates,
  subscribeScanStatus,
} from '@/lib/railgun/sync'
import { closeSdkRead, readSdkUsdcBalance, readSdkYieldShares } from '@/lib/railgun/sdk-read'
import { trackError } from '@/lib/telemetry'

/**
 * Subscribe to balance updates while the wallet is unlocked. On unlock:
 *   1. Subscribe to SDK scan-status events → drive `syncStateAtom` for the INITIAL load only
 *      (background polls don't revert it — see the subscription below)
 *   2. Subscribe to SDK balance-update events (lazily installs the global SDK callback)
 *   3. Trigger an initial `refreshShieldedBalances` so the first scan starts
 *   4. On each event (or initial query), READ (not sync) BOTH shielded USDC and ayUSDC shares from
 *      the @armada/sdk scan state (which resolves the token set from the deployment internally)
 *
 * On lock or unmount, unsubscribes, zeroes both atoms, and closes the SDK read instance.
 *
 * The `latestWalletIdRef` guards against stale-closure writes if the wallet flips while a
 * balance query is in flight — only the most recent walletId is allowed to write atoms.
 */
export function useShieldedBalanceSync(): void {
  const active = useAtomValue(activeShieldedWalletAtom)
  const setShieldedUsdc = useSetAtom(shieldedUsdcAtom)
  const setYieldShares = useSetAtom(yieldSharesAtom)
  const setSyncState = useSetAtom(syncStateAtom)
  // Bumped by useSyncRetry ("Try Again"). Included in the effect deps so a bump re-runs the
  // subscribe + initial-scan path below.
  const retryEpoch = useAtomValue(syncRetryEpochAtom)
  const latestWalletIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (active?.status !== 'unlocked') {
      // Lock / reset / account-switch path — drop balance state so stale data doesn't linger past
      // a session, AND reset the sync gate to idle. Without the sync reset, the NEXT wallet
      // inherits this one's 'complete' status, so its dashboard renders ungated with a null
      // balance and enabled spend buttons until its own first scan event fires. (W-1)
      latestWalletIdRef.current = null
      setShieldedUsdc(null)
      setYieldShares(null)
      setSyncState({ status: 'idle', progress: 0 })
      // This hook owns the @armada/sdk read instance — tear it down on lock.
      void closeSdkRead()
      return
    }

    const walletId = active.id
    latestWalletIdRef.current = walletId
    let unsubscribe: (() => void) | null = null
    let unsubscribeScan: (() => void) | null = null
    let cancelled = false

    // Drive the INITIAL-load sync gate/banner (`syncStateAtom`) off the SDK wallet's scan lifecycle:
    // scan:started → syncing, scan:progress → the running fraction, scan:complete → complete,
    // scan:error → failed. `syncStateAtom` tracks the initial load ONLY. After the first `complete`,
    // the 15s poll keeps syncing the chain in the background, but those routine scan:started/complete
    // blips are ignored here — otherwise the full "Loading your private balance" UI (BalanceHero /
    // SyncBanner) would flicker to the progress display on every poll. A fresh unlock or a "Try Again"
    // retry re-runs this effect with `initialSyncComplete` reset, which re-arms the display.
    let initialSyncComplete = false
    unsubscribeScan = subscribeScanStatus((status) => {
      if (cancelled || latestWalletIdRef.current !== walletId) return
      if (initialSyncComplete) return // steady state: background syncs must not revert the UI
      setSyncState(status)
      if (status.status === 'complete') initialSyncComplete = true
    })

    async function refreshAll(): Promise<void> {
      try {
        // READ shielded USDC + yield-vault shares from the @armada/sdk scan state in parallel — no
        // sync. This runs from the balance-bus subscription, which fires BECAUSE a sync just
        // completed; re-syncing here would be circular (a sync emits scan:complete → this read →
        // another sync → …). Syncing is driven only by the poll + post-tx refresh + initial scan.
        // Promise.allSettled so one chain hiccup doesn't blank the other atom.
        const [usdcResult, sharesResult] = await Promise.allSettled([
          readSdkUsdcBalance(),
          readSdkYieldShares(),
        ])

        if (cancelled || latestWalletIdRef.current !== walletId) return

        if (usdcResult.status === 'fulfilled') {
          setShieldedUsdc(usdcResult.value)
        }
        if (sharesResult.status === 'fulfilled') {
          setYieldShares(sharesResult.value)
        }
      } catch (err) {
        trackError('useShieldedBalanceSync.refreshAll', err, {
          scope: 'shielded.balance',
          message: 'balance query failed',
        })
      }
    }

    // Order: subscribe FIRST (so a fast scan completion isn't missed), then kick off refresh.
    void (async () => {
      try {
        unsubscribe = await subscribeBalanceUpdates(() => {
          void refreshAll()
        })
        if (cancelled) {
          unsubscribe()
          return
        }
        await refreshShieldedBalances(walletId)
        await refreshAll()
      } catch (err) {
        // The scan never started (e.g. RPC unreachable), so the SDK's merkletree callback won't
        // fire 'Incomplete' to mark the sync failed. Mark it here so the gate can offer Try Again.
        if (!cancelled && latestWalletIdRef.current === walletId) {
          setSyncState({ status: 'failed', progress: 0 })
        }
        trackError('useShieldedBalanceSync.init', err, {
          scope: 'shielded.balance',
          message: 'subscribe + initial scan failed',
        })
      }
    })()

    return () => {
      cancelled = true
      if (unsubscribe) unsubscribe()
      if (unsubscribeScan) unsubscribeScan()
    }
  }, [active?.id, active?.status, retryEpoch, setShieldedUsdc, setYieldShares, setSyncState])
}

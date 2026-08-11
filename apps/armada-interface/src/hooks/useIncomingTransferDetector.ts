// ABOUTME: Bumps historyRecoveryEpochAtom whenever the SDK signals a balance change, so useHistoryRecovery runs an incremental scan and picks up freshly-received transfers from other wallets.
// ABOUTME: Mount once at App root. Shares the scan path with useHistoryRecovery via the epoch atom — no parallel SDK calls, no separate persistence pipeline.

import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeShieldedWalletAtom } from '@/state/wallet'
import { historyRecoveryEpochAtom } from '@/state/history'
import { subscribeBalanceUpdates } from '@/lib/shielded/sync'
import { trackError } from '@/lib/telemetry'

/**
 * Trailing debounce window for coalescing balance-event bursts into one epoch bump. The SDK fires
 * several balance-update events in quick succession during a single scan (one per affected tree /
 * token); without coalescing, each would trigger a separate `useHistoryRecovery` delta scan. A 2s
 * quiet window collapses the burst into one scan while keeping received-transfer latency low. (P1-29)
 */
const SCAN_DEBOUNCE_MS = 2_000

/**
 * Subscribe to SDK balance-update events while the wallet is unlocked. On each event, bump
 * `historyRecoveryEpochAtom` — `useHistoryRecovery`'s effect re-runs and fetches the delta
 * since the persisted checkpoint. The dedup guard inside `runScanAndPersist` skips items
 * whose `sourceTxHash` already matches a record in `txListAtom`, so the user's own outgoing
 * tx doesn't get a duplicate synthetic row tacked on.
 *
 * Rationale for piggybacking on balance events vs polling: every relevant on-chain event for
 * the wallet (shield, transact, incoming transfer, yield deposit/withdraw) already produces a
 * balance-update notification through the SDK. Polling would either duplicate that signal or
 * miss it. Sharing the existing subscription costs one extra listener.
 */
export function useIncomingTransferDetector(): void {
  const active = useAtomValue(activeShieldedWalletAtom)
  const setEpoch = useSetAtom(historyRecoveryEpochAtom)

  useEffect(() => {
    if (active?.status !== 'unlocked') return

    let unsubscribe: (() => void) | null = null
    let cancelled = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    void (async () => {
      try {
        unsubscribe = await subscribeBalanceUpdates(() => {
          // Every event on the bus is already scoped to the unlocked wallet (the SDK read instance
          // is that wallet), so no per-wallet filtering is needed.
          // Trailing-debounce the epoch bump: each event resets the timer, so a burst of SDK
          // events during one scan collapses into a single bump after the quiet window. Bump as
          // a function-update so it composes rather than racing on a stale read.
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            debounceTimer = null
            setEpoch((prev) => prev + 1)
          }, SCAN_DEBOUNCE_MS)
        })
        if (cancelled && unsubscribe) {
          unsubscribe()
          unsubscribe = null
        }
      } catch (err) {
        trackError('history.incoming.subscribe', err, {
          scope: 'history.incoming',
          message: 'failed to subscribe to balance updates',
        })
      }
    })()

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (unsubscribe) unsubscribe()
    }
  }, [active?.id, active?.status, setEpoch])
}

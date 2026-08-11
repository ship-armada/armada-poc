// ABOUTME: Periodic @armada/sdk wallet.sync() driver — replaces the stock engine's internal scan poller
// ABOUTME: so live balance + incoming-transfer updates keep flowing. Visibility-gated. Mount once at App root.

import { useQuery } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { activeShieldedWalletAtom } from '@/state/wallet'
import { tabVisibleAtom } from '@/state/visibility'
import { refreshShieldedBalances } from '@/lib/railgun/sync'

// Cadence for the background scan. The SDK's sync is a cheap no-op (`scanned:false`) when the chain
// head hasn't advanced, so a tight-ish interval keeps received transfers fresh without real cost.
const SYNC_POLL_INTERVAL_MS = 15_000

/**
 * Drive `wallet.sync()` on an interval while the wallet is unlocked and the tab is visible. Each sync
 * emits the SDK's scan/balance/note events, which the balance bus fans out to `useShieldedBalanceSync`
 * (re-reads balances) and `useIncomingTransferDetector` (re-runs history recovery). This is what keeps
 * the shielded view live now that the stock engine's continuous scan is being retired.
 */
export function useShieldedSyncPoll(): void {
  const active = useAtomValue(activeShieldedWalletAtom)
  const tabVisible = useAtomValue(tabVisibleAtom)
  const enabled = active?.status === 'unlocked' && tabVisible

  useQuery({
    queryKey: ['shielded-sync-poll', active?.id ?? null],
    queryFn: async () => {
      await refreshShieldedBalances()
      return Date.now()
    },
    enabled,
    refetchInterval: enabled ? SYNC_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    // The value is irrelevant — this query is a side-effecting poller, not a data source.
    staleTime: Infinity,
    gcTime: 0,
  })
}

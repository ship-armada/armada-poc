// ABOUTME: Returns a `retry()` that re-attempts the initial shielded-balance sync after a failure.
// ABOUTME: Optimistically flips sync state to 'syncing' (so the UI leaves the failed view immediately), then bumps syncRetryEpochAtom to re-run useShieldedBalanceSync.

import { useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { syncRetryEpochAtom, syncStateAtom } from '@/state/wallet'
import { track } from '@/lib/telemetry'

/**
 * Hook returning a stable `retry` callback for the "Try Again" affordance on a failed initial
 * sync. Optimistically sets `syncStateAtom` to `{ status: 'syncing', progress: 0 }` so the UI
 * drops the failed state instantly, then increments `syncRetryEpochAtom` — which is in
 * `useShieldedBalanceSync`'s effect deps, so the subscription tears down and the scan re-runs.
 * If the retry also fails, the hook's init path re-marks the state failed.
 */
export function useSyncRetry(): () => void {
  const setSync = useSetAtom(syncStateAtom)
  const bumpEpoch = useSetAtom(syncRetryEpochAtom)
  return useCallback(() => {
    track('shielded.syncRetry', {})
    setSync({ status: 'syncing', progress: 0 })
    bumpEpoch((n) => n + 1)
  }, [setSync, bumpEpoch])
}

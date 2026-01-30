import { useState, useEffect, useRef } from 'react'

export type SyncIconState = 'idle' | 'syncing' | 'complete' | 'error'

interface UseSyncIconStateOptions {
  /** Whether sync is currently in progress */
  isSyncing: boolean
  /** Current sync status */
  status: 'idle' | 'syncing' | 'complete' | 'error' | string | undefined
  /** Timeout duration in milliseconds before resetting to idle (default: 15000) */
  resetTimeoutMs?: number
}

/**
 * Hook to manage sync icon state transitions with automatic timeout reset
 * 
 * State transitions:
 * - idle → syncing (when isSyncing becomes true)
 * - syncing → complete (when status becomes 'complete')
 * - syncing → error (when status becomes 'error')
 * - complete → idle (after timeout)
 * - error → idle (after timeout)
 * 
 * @param options - Sync state options
 * @returns Current sync icon state
 */
export function useSyncIconState({
  isSyncing,
  status,
  resetTimeoutMs = 15000,
}: UseSyncIconStateOptions): SyncIconState {
  const [syncIconState, setSyncIconState] = useState<SyncIconState>('idle')
  const syncCompleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Clear any existing timeout
    if (syncCompleteTimeoutRef.current) {
      clearTimeout(syncCompleteTimeoutRef.current)
      syncCompleteTimeoutRef.current = null
    }

    if (isSyncing) {
      setSyncIconState('syncing')
    } else if (status === 'complete') {
      setSyncIconState('complete')
      // Reset to idle after timeout
      syncCompleteTimeoutRef.current = setTimeout(() => {
        setSyncIconState('idle')
      }, resetTimeoutMs)
    } else if (status === 'error') {
      setSyncIconState('error')
      // Reset to idle after timeout
      syncCompleteTimeoutRef.current = setTimeout(() => {
        setSyncIconState('idle')
      }, resetTimeoutMs)
    } else {
      setSyncIconState('idle')
    }

    return () => {
      if (syncCompleteTimeoutRef.current) {
        clearTimeout(syncCompleteTimeoutRef.current)
      }
    }
  }, [isSyncing, status, resetTimeoutMs])

  return syncIconState
}

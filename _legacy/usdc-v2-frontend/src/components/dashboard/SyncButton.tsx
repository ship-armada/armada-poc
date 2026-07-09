import { RefreshCw, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/common/Button'
import type { SyncIconState } from '@/hooks/useSyncIconState'

export interface SyncButtonProps {
  /** Current sync icon state */
  syncIconState: SyncIconState
  /** Whether sync is ready to start */
  isReady: boolean
  /** Whether sync is currently in progress */
  isSyncing: boolean
  /** Whether there's an error state */
  hasError: boolean
  /** Click handler */
  onClick: () => void
}

/**
 * Sync button component with state-aware rendering
 * 
 * Displays different states:
 * - Retry button (when error)
 * - Sync button (when ready)
 * - Syncing button (when in progress)
 * - Hidden (when not applicable)
 */
export function SyncButton({
  syncIconState,
  isReady,
  isSyncing,
  hasError,
  onClick,
}: SyncButtonProps) {
  if (hasError) {
    return (
      <Button
        variant="ghost"
        className="h-7 px-3 text-xs gap-1.5 border border-border bg-transparent hover:bg-muted/50"
        onClick={onClick}
        disabled={!isReady || isSyncing}
      >
        {syncIconState === 'syncing' ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : syncIconState === 'error' ? (
          <XCircle className="h-3.5 w-3.5" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Retry
      </Button>
    )
  }

  if (isReady && !isSyncing && !hasError) {
    return (
      <Button
        variant="ghost"
        className="h-7 px-3 text-xs gap-1.5 border border-border bg-transparent hover:bg-muted/50"
        onClick={onClick}
      >
        {syncIconState === 'syncing' ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : syncIconState === 'complete' ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Sync
      </Button>
    )
  }

  if (isSyncing) {
    return (
      <Button
        variant="ghost"
        className="h-7 px-3 text-xs gap-1.5 border border-border bg-transparent"
        disabled
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Syncing
      </Button>
    )
  }

  return null
}

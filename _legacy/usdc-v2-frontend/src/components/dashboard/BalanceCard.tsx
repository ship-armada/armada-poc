import { Loader2, AlertCircle } from 'lucide-react'
import { Tooltip } from '@/components/common/Tooltip'
import { ShieldButton } from './ShieldButton'
import { SyncButton } from './SyncButton'
import type { SyncIconState } from '@/hooks/useSyncIconState'

export interface BalanceCardProps {
  /** Balance type */
  type: 'transparent' | 'shielded'
  /** Display balance value */
  balance: string | undefined | null
  /** Whether balance has an error */
  hasError: boolean
  /** Whether balance is loading */
  isLoading?: boolean
  /** Error message for tooltip */
  errorMessage?: string
  /** Shield button props (only for transparent) */
  shieldButton?: {
    disabled: boolean
    loading: boolean
    onClick: () => void
    title: string
  }
  /** Sync button props (only for shielded) */
  syncButton?: {
    syncIconState: SyncIconState
    isReady: boolean
    isSyncing: boolean
    hasError: boolean
    onClick: () => void
  }
  /** Refresh indicator props (only for shielded) */
  refreshIndicator?: {
    show: boolean
    timeAgoText: string
    color: string
  }
  /** Whether to show shielded sync progress (only for shielded) */
  showSyncProgress?: boolean
}

/**
 * Reusable balance card component
 *
 * Displays either transparent or shielded balance with appropriate actions and indicators.
 */
export function BalanceCard({
  type,
  balance,
  hasError,
  isLoading = false,
  errorMessage,
  shieldButton,
  syncButton,
  refreshIndicator,
}: BalanceCardProps) {
  const isTransparent = type === 'transparent'
  const bgClass = isTransparent
    ? 'bg-foreground/2'
    : 'bg-primary/5'
  const labelClass = isTransparent
    ? 'text-muted-foreground bg-foreground/10'
    : 'text-primary bg-primary/10'
  const balanceTextClass = isTransparent
    ? ''
    : 'text-primary'

  return (
    <div className={`border p-5 rounded-sm ${bgClass}`}>
      <div className="flex items-center gap-2 justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium uppercase tracking-wider p-2 rounded-sm ${labelClass}`}>
            {isTransparent ? 'Transparent' : 'Shielded'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isTransparent && shieldButton && (
            <ShieldButton
              variant="inline"
              disabled={shieldButton.disabled}
              loading={shieldButton.loading}
              onClick={shieldButton.onClick}
              title={shieldButton.title}
            />
          )}
          {!isTransparent && syncButton && (
            <>
              <SyncButton
                syncIconState={syncButton.syncIconState}
                isReady={syncButton.isReady}
                isSyncing={syncButton.isSyncing}
                hasError={syncButton.hasError}
                onClick={syncButton.onClick}
              />
              {refreshIndicator?.show && (
                <Tooltip content={`Last refreshed ${refreshIndicator.timeAgoText}`} side="top">
                  <div
                    className={`h-2 w-2 rounded-full ${refreshIndicator.color}`}
                    aria-label={`Last refreshed ${refreshIndicator.timeAgoText}`}
                  />
                </Tooltip>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <img
          src="/assets/logos/usdc-logo.svg"
          alt="USDC"
          className="h-6 w-6"
        />
        <p className={`text-2xl font-medium ${balanceTextClass}`}>
          {balance || '0.00'} <span className="text-sm font-semibold text-muted-foreground">USDC</span>
        </p>
        {isLoading && !isTransparent && (
          <Loader2 className="h-4 w-4 animate-spin text-info" aria-label="Loading shielded balance" />
        )}
        {hasError && errorMessage && (
          <Tooltip content={errorMessage} side="top">
            <AlertCircle
              className="h-4 w-4 text-error"
              aria-label={`${isTransparent ? 'Transparent' : 'Shielded'} balance error`}
            />
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/**
 * Retry Status Tracking Button Component
 * 
 * Button to retry status tracking for a transaction that has errored or timed out.
 * Restarts the entire status tracking flow from the beginning.
 */

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { retryPolling } from '@/services/polling/chainPollingService'
import { canRetryPolling } from '@/services/polling/pollingStatusUtils'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

export interface RetryPollingButtonProps {
  transaction: StoredTransaction
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function RetryPollingButton({
  transaction,
  variant = 'default',
  size = 'sm',
  className,
}: RetryPollingButtonProps) {
  const [isLoading, setIsLoading] = useState(false)
  const { notify } = useToast()

  const handleRetry = async () => {
    if (!canRetryPolling(transaction)) {
      notify({
        title: 'Cannot Retry',
        description: 'This transaction cannot be retried.',
        level: 'error',
      })
      return
    }

    setIsLoading(true)
    try {
      await retryPolling(transaction.id)
      notify({
        title: 'Status Tracking Retried',
        description: 'Transaction status tracking has been restarted from the beginning.',
        level: 'success',
      })
    } catch (error) {
      notify({
        title: 'Retry Failed',
        description: error instanceof Error ? error.message : 'Failed to retry status tracking.',
        level: 'error',
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (!transaction.pollingState || !canRetryPolling(transaction)) {
    return null
  }

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-base',
  }

  const variantClasses = {
    default: 'bg-transparent text-muted hover:bg-muted/10 font-semibold transition-colors',
    outline: 'border border-border bg-background hover:bg-muted',
    ghost: 'hover:bg-muted',
  }

  return (
    <button
      type="button"
      onClick={handleRetry}
      disabled={isLoading}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium transition-colors rounded-md',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      aria-label="Retry status tracking"
    >
      <RefreshCw className={cn(
        'h-4 w-4 font-semibold',
        size === 'lg' && 'h-4 w-4',
        isLoading && 'animate-spin',
      )} />
      <span>{isLoading ? 'Retrying...' : 'Retry Tracing'}</span>
    </button>
  )
}


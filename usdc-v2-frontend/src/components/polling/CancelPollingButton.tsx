/**
 * Cancel Status Tracking Button Component
 * 
 * Button to cancel active status tracking for a transaction.
 */

import { useState } from 'react'
import { X } from 'lucide-react'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { cancelPolling } from '@/services/polling/chainPollingService'
import { canCancelPolling } from '@/services/polling/pollingStatusUtils'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

export interface CancelPollingButtonProps {
  transaction: StoredTransaction
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function CancelPollingButton({
  transaction,
  variant = 'outline',
  size = 'sm',
  className,
}: CancelPollingButtonProps) {
  const [isLoading, setIsLoading] = useState(false)
  const { notify } = useToast()

  const handleCancel = () => {
    if (!canCancelPolling(transaction)) {
      notify({
        title: 'Cannot Cancel',
        description: 'This transaction cannot be cancelled.',
        level: 'error',
      })
      return
    }

    setIsLoading(true)
    try {
      cancelPolling(transaction.id)
      notify({
        title: 'Status Tracking Cancelled',
        description: 'Transaction status tracking has been cancelled. You can resume it later.',
        level: 'info',
      })
    } catch (error) {
      notify({
        title: 'Cancel Failed',
        description: error instanceof Error ? error.message : 'Failed to cancel status tracking.',
        level: 'error',
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (!transaction.pollingState || !canCancelPolling(transaction)) {
    return null
  }

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-base',
  }

  const variantClasses = {
    default: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    outline: 'border border-border bg-background hover:bg-muted',
    ghost: 'hover:bg-muted',
  }

  return (
    <button
      type="button"
      onClick={handleCancel}
      disabled={isLoading}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium transition-colors rounded-md',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      aria-label="Cancel status tracking"
    >
      <X className={cn(
        'h-3 w-3',
        size === 'lg' && 'h-4 w-4',
        isLoading && 'animate-spin',
      )} />
      <span>{isLoading ? 'Cancelling...' : 'Cancel Tracking'}</span>
    </button>
  )
}


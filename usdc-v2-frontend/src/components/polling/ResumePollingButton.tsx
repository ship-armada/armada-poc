/**
 * Resume Status Tracking Button Component
 * 
 * Button to resume status tracking for a transaction that was cancelled, errored, or timed out.
 */

import { useState } from 'react'
import { Play } from 'lucide-react'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { resumePolling } from '@/services/polling/chainPollingService'
import { canResumePolling } from '@/services/polling/pollingStatusUtils'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

export interface ResumePollingButtonProps {
  transaction: StoredTransaction
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function ResumePollingButton({
  transaction,
  variant = 'default',
  size = 'sm',
  className,
}: ResumePollingButtonProps) {
  const [isLoading, setIsLoading] = useState(false)
  const { notify } = useToast()

  const handleResume = async () => {
    if (!canResumePolling(transaction)) {
      notify({
        title: 'Cannot Resume',
        description: 'This transaction cannot be resumed.',
        level: 'error',
      })
      return
    }

    setIsLoading(true)
    try {
      await resumePolling(transaction.id)
      notify({
        title: 'Status Tracking Resumed',
        description: 'Transaction status tracking has been resumed.',
        level: 'success',
      })
    } catch (error) {
      notify({
        title: 'Resume Failed',
        description: error instanceof Error ? error.message : 'Failed to resume status tracking.',
        level: 'error',
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (!transaction.pollingState || !canResumePolling(transaction)) {
    return null
  }

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-base',
  }

  const variantClasses = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    outline: 'border border-border bg-background hover:bg-muted',
    ghost: 'hover:bg-muted',
  }

  return (
    <button
      type="button"
      onClick={handleResume}
      disabled={isLoading}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium transition-colors rounded-md',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      aria-label="Resume status tracking"
    >
      <Play className={cn(
        'h-3 w-3',
        size === 'lg' && 'h-4 w-4',
        isLoading && 'animate-spin',
      )} />
      <span>{isLoading ? 'Resuming...' : 'Resume Tracking'}</span>
    </button>
  )
}


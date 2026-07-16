/**
 * Utility functions for transaction status styling.
 * Provides consistent status badge and icon styling across transaction components.
 */

import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import {
  isSuccess,
  isError,
  getEffectiveStatus,
  isInProgress,
  hasClientTimeout,
} from '@/services/tx/transactionStatusService'

/**
 * Status badge color classes
 */
export interface StatusBadgeClasses {
  bg: string
  text: string
  border: string
}

/**
 * Get status badge color classes based on transaction status.
 * 
 * @param transaction - The transaction
 * @returns Object with background, text, and border color classes
 */
export function getStatusBadgeClasses(transaction: StoredTransaction): StatusBadgeClasses {
  const effectiveStatus = getEffectiveStatus(transaction)
  const inProgress = isInProgress(transaction)

  if (isSuccess(transaction)) {
    return {
      bg: 'bg-success/20',
      text: 'text-success',
      border: 'border-success/30',
    }
  } else if (isError(transaction)) {
    return {
      bg: 'bg-error/20',
      text: 'text-error',
      border: 'border-error/30',
    }
  } else if (effectiveStatus === 'user_action_required') {
    return {
      bg: 'bg-warning/20',
      text: 'text-warning',
      border: 'border-warning/30',
    }
  } else if (effectiveStatus === 'undetermined') {
    return {
      bg: 'bg-warning/20',
      text: 'text-warning',
      border: 'border-warning/30',
    }
  } else if (inProgress) {
    return {
      bg: 'bg-muted',
      text: 'text-muted-foreground',
      border: 'border-muted',
    }
  }

  // Default
  return {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    border: 'border-muted',
  }
}

/**
 * Transaction icon color classes
 */
export interface TransactionIconClasses {
  bg: string
  text: string
}

/**
 * Get transaction icon color classes based on transaction status and direction.
 * 
 * @param transaction - The transaction
 * @returns Object with background and text color classes for the icon
 */
export function getTransactionIconClasses(transaction: StoredTransaction): TransactionIconClasses {
  const effectiveStatus = getEffectiveStatus(transaction)

  if (isError(transaction)) {
    // Failed/error status
    return {
      bg: 'bg-error/10',
      text: 'text-error',
    }
  } else if (effectiveStatus === 'undetermined' || hasClientTimeout(transaction)) {
    // Timeout/undetermined status
    return {
      bg: 'bg-warning/10',
      text: 'text-warning',
    }
  } else {
    // Default colors based on transaction direction
    return {
      bg: transaction.direction === 'deposit' ? 'bg-primary/10' : 'bg-info/10',
      text: transaction.direction === 'deposit' ? 'text-primary' : 'text-info',
    }
  }
}


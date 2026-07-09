/**
 * Polling Status Utilities
 * 
 * Helper functions for extracting and formatting polling status information
 * for display in UI components.
 */

import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import type { ChainKey, FlowType } from '@/shared/flowStages'
import { getChainOrder } from '@/shared/flowStages'
import type { ChainStatus, FlowPollingStatus } from './types'
import { sanitizeError } from '@/utils/errorSanitizer'

/**
 * Get polling status for a transaction
 */
export function getPollingStatus(tx: StoredTransaction): FlowPollingStatus | null {
  return tx.pollingState?.flowStatus || null
}

/**
 * Get chain status for a specific chain
 */
export function getChainStatus(
  tx: StoredTransaction,
  chain: ChainKey,
): ChainStatus | null {
  return tx.pollingState?.chainStatus[chain] || null
}

/**
 * Get all chain statuses for a transaction
 */
export function getAllChainStatuses(tx: StoredTransaction): Record<ChainKey, ChainStatus | null> {
  const flowType: FlowType = tx.direction === 'deposit' ? 'deposit' : 'payment'
  const chainOrder = getChainOrder(flowType)
  const statuses: Record<ChainKey, ChainStatus | null> = {
    evm: null,
    noble: null,
    namada: null,
  }

  for (const chain of chainOrder) {
    statuses[chain] = getChainStatus(tx, chain)
  }

  return statuses
}

/**
 * Get current chain being polled
 */
export function getCurrentPollingChain(tx: StoredTransaction): ChainKey | null {
  return tx.pollingState?.currentChain || null
}

/**
 * Get last updated timestamp for polling
 */
export function getPollingLastUpdated(tx: StoredTransaction): number | null {
  return tx.pollingState?.lastUpdatedAt || null
}

/**
 * Format chain status for display
 */
export function formatChainStatus(status: ChainStatus | null): string {
  if (!status) {
    return 'Not started'
  }

  switch (status.status) {
    case 'success':
      return 'Success'
    case 'tx_error':
      return `Error: ${status.errorMessage || 'Transaction failed'}`
    case 'polling_error':
      return `Polling Error: ${status.errorMessage || 'Unknown error'}`
    case 'polling_timeout':
      return `Timeout: ${status.errorMessage || 'Polling timed out'}`
    case 'cancelled':
      return 'Cancelled'
    case 'pending':
      return 'In progress'
    default:
      return 'Unknown'
  }
}

/**
 * Get chain status icon/emoji for display
 */
export function getChainStatusIcon(status: ChainStatus | null): string {
  if (!status) {
    return '⏳'
  }

  switch (status.status) {
    case 'success':
      return '✓'
    case 'tx_error':
    case 'polling_error':
      return '✗'
    case 'polling_timeout':
      return '⏱'
    case 'cancelled':
      return '🚫'
    case 'pending':
      return '⏳'
    default:
      return '?'
  }
}

/**
 * Get chain status color class for display
 */
export function getChainStatusColor(status: ChainStatus | null): string {
  if (!status) {
    return 'text-muted-foreground'
  }

  switch (status.status) {
    case 'success':
      return 'text-success'
    case 'tx_error':
    case 'polling_error':
      return 'text-error'
    case 'polling_timeout':
      return 'text-warning'
    case 'cancelled':
      return 'text-muted-foreground'
    case 'pending':
      return 'text-info'
    default:
      return 'text-muted-foreground'
  }
}

/**
 * Format error message with timestamp and error code if available
 * Uses error sanitizer to provide human-readable messages
 */
export function formatChainErrorMessage(status: ChainStatus | null): string | null {
  if (!status || !status.errorMessage) {
    return null
  }

  // Sanitize the error message first
  const sanitized = sanitizeError(status.errorMessage)
  const parts: string[] = [sanitized.message]

  // Add error category if available
  if (status.errorCategory) {
    parts.push(`[${status.errorCategory.toUpperCase()}]`)
  }

  // Add error code if available
  if (status.errorCode) {
    parts.push(`[Code: ${status.errorCode}]`)
  }

  // Add recovery suggestion if available
  if (status.recoveryAction && status.recoveryAction !== 'none') {
    const recoveryHint = getRecoveryHint(status.recoveryAction)
    if (recoveryHint) {
      parts.push(`(${recoveryHint})`)
    }
  }

  // Add retry count if available
  if (status.retryCount && status.retryCount > 0) {
    parts.push(`(Retries: ${status.retryCount})`)
  }

  // Add timestamp if available
  const timestamp = status.errorOccurredAt
    ? new Date(status.errorOccurredAt).toLocaleTimeString()
    : null

  if (timestamp) {
    parts.push(`at ${timestamp}`)
  }

  return parts.join(' ')
}

/**
 * Get sanitized error message only (without metadata)
 */
export function getSanitizedChainErrorMessage(status: ChainStatus | null): string | null {
  if (!status || !status.errorMessage) {
    return null
  }
  return sanitizeError(status.errorMessage).message
}

/**
 * Get human-readable recovery hint
 */
function getRecoveryHint(recoveryAction: ChainStatus['recoveryAction']): string | null {
  switch (recoveryAction) {
    case 'retry':
      return 'Try again'
    case 'check_connection':
      return 'Check your internet connection'
    case 'check_rpc_status':
      return 'RPC server may be down'
    case 'contact_support':
      return 'Contact support if issue persists'
    default:
      return null
  }
}

/**
 * Check if polling is active for a transaction
 */
export function isPollingActive(tx: StoredTransaction): boolean {
  const status = getPollingStatus(tx)
  return status === 'pending'
}

/**
 * Check if any chain has errored or timed out
 */
function hasChainError(tx: StoredTransaction): boolean {
  if (!tx.pollingState) {
    return false
  }

  const chainStatuses = tx.pollingState.chainStatus
  return Object.values(chainStatuses).some(
    (status) =>
      status?.status === 'tx_error' ||
      status?.status === 'polling_error' ||
      status?.status === 'polling_timeout',
  )
}

/**
 * Check if polling can be resumed for a transaction
 */
export function canResumePolling(tx: StoredTransaction): boolean {
  const status = getPollingStatus(tx)
  
  // Check overall flow status
  if (
    status === 'cancelled' ||
    status === 'polling_error' ||
    status === 'polling_timeout' ||
    status === 'tx_error' ||
    status === 'user_action_required'
  ) {
    return true
  }

  // Fallback: Check individual chain statuses if flowStatus is still pending
  // This handles cases where orchestrator hasn't updated flowStatus yet
  if (status === 'pending' && hasChainError(tx)) {
    return true
  }

  return false
}

/**
 * Check if polling can be cancelled for a transaction
 */
export function canCancelPolling(tx: StoredTransaction): boolean {
  const status = getPollingStatus(tx)
  
  // Can cancel only if polling is actively running (pending)
  // Don't show cancel button for errored/timeout states (use retry instead)
  if (status === 'pending') {
    // Only show cancel if no chains have errored yet (still actively polling)
    const chainStatuses = tx.pollingState?.chainStatus
    if (chainStatuses) {
      const hasAnyError = Object.values(chainStatuses).some(
        (chainStatus) =>
          chainStatus?.status === 'tx_error' ||
          chainStatus?.status === 'polling_error' ||
          chainStatus?.status === 'polling_timeout',
      )
      // Only allow cancel if no errors yet (still actively polling)
      return !hasAnyError
    }
    return true
  }

  return false
}

/**
 * Check if polling can be retried (restarted from beginning)
 */
export function canRetryPolling(tx: StoredTransaction): boolean {
  const status = getPollingStatus(tx)
  
  // Can retry if there's an error, timeout, cancellation, user action required, or success
  // (success allows re-polling to verify current state)
  if (
    status === 'polling_error' ||
    status === 'polling_timeout' ||
    status === 'tx_error' ||
    status === 'cancelled' ||
    status === 'user_action_required' ||
    status === 'success'
  ) {
    return true
  }

  // Fallback: Check individual chain statuses if flowStatus is still pending
  // This handles cases where orchestrator hasn't updated flowStatus yet
  if (status === 'pending' && hasChainError(tx)) {
    return true
  }

  return false
}


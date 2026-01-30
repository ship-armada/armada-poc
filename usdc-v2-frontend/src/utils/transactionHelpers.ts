/**
 * Shared transaction submission utility functions
 */

import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { transactionStorageService } from '@/services/tx/transactionStorageService'
import { sanitizeError } from '@/utils/errorSanitizer'
import { logger } from '@/utils/logger'

export type TransactionType = 'deposit' | 'send' | 'shield'

/**
 * Create a unique toast ID for transaction status updates
 */
export function createTransactionToastId(type: TransactionType, timestamp?: number): string {
  const ts = timestamp ?? Date.now()
  return `${type}-tx-${ts}`
}

/**
 * Handle transaction error and save error transaction to storage
 */
export function handleTransactionError(
  error: unknown,
  currentTx: StoredTransaction | undefined,
  tx: StoredTransaction | undefined,
  transactionType: TransactionType,
  selectedChain: string | undefined,
  transactionDetails: Record<string, unknown>,
  upsertTransaction: (tx: StoredTransaction) => void
): { message: string; errorTx: StoredTransaction } {
  const sanitized = sanitizeError(error)
  const message = sanitized.message

  // Save error transaction to storage for history tracking
  const errorTx: StoredTransaction = currentTx
    ? {
        ...currentTx,
        status: 'error',
        errorMessage: message,
        updatedAt: Date.now(),
      }
    : {
        id: tx?.id || crypto.randomUUID(),
        createdAt: tx?.createdAt || Date.now(),
        updatedAt: Date.now(),
        chain: tx?.chain || selectedChain || '',
        direction: transactionType === 'deposit' ? 'deposit' : 'send',
        status: 'error',
        errorMessage: message,
        ...transactionDetails,
      }

  try {
    transactionStorageService.saveTransaction(errorTx)
    upsertTransaction(errorTx)
  } catch (saveError) {
    logger.error(`[transactionHelpers] Failed to save error transaction:`, {
      error: saveError instanceof Error ? saveError.message : String(saveError),
    })
  }

  return { message, errorTx }
}

/**
 * Fetch and set explorer URL for a transaction
 */
export async function fetchAndSetExplorerUrl(
  chain: string | undefined,
  hash: string,
  setState: (updater: (prev: any) => any) => void,
  getUrlFn: (chain: string | undefined, hash: string) => Promise<string>
): Promise<void> {
  if (!chain) {
    return
  }

  try {
    const url = await getUrlFn(chain, hash)
    setState((prev: any) => ({ ...prev, explorerUrl: url }))
  } catch (error) {
    // Silently fail if explorer URL can't be fetched
    logger.debug('[transactionHelpers] Failed to fetch explorer URL', {
      chain,
      hash: hash.slice(0, 16) + '...',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Save transaction with details to storage and update state
 */
export function saveTransactionWithDetails(
  tx: StoredTransaction,
  details: Record<string, unknown>,
  upsertTransaction: (tx: StoredTransaction) => void
): StoredTransaction {
  const txWithDetails: StoredTransaction = {
    ...tx,
    ...details,
    updatedAt: Date.now(),
  }

  transactionStorageService.saveTransaction(txWithDetails)
  upsertTransaction(txWithDetails)

  return txWithDetails
}


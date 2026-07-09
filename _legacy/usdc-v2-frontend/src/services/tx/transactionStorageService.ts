/**
 * Unified Transaction Storage Service
 * 
 * Single source of truth for all transaction data in localStorage.
 * Replaces fragmented storage across DepositMetadata, PaymentMetadata, and in-memory Jotai atom.
 * 
 * This service provides:
 * - CRUD operations for transactions
 * - Helper methods for filtering (in-progress, completed)
 * - localStorage serialization/deserialization
 * - Migration path from legacy storage formats
 */

import type { TrackedTransaction } from '@/types/tx'
import type { ChainStage } from '@/types/flow'
import type { DepositTransactionDetails } from '@/services/deposit/depositService'
import type { PollingState } from '@/services/polling/types'
import type { DepositTxData } from './txBuilder'

// Stub type for payment details (payment service removed with Namada keychain)
interface PaymentTransactionDetails {
  amount: string
  destinationAddress: string
  chainName: string
}
import { saveItem, loadItem, deleteItem } from '@/services/storage/localStore'
import { logger } from '@/utils/logger'

/**
 * Get the effective status of a transaction (helper to avoid circular dependency).
 * Uses pollingState.flowStatus when available, otherwise falls back to top-level status.
 */
function getEffectiveStatusForFilter(tx: StoredTransaction): StoredTransaction['status'] {
  // Use pollingState.flowStatus if available
  if (tx.pollingState?.flowStatus) {
    const flowStatus = tx.pollingState.flowStatus
    if (flowStatus === 'success') {
      return 'finalized'
    } else if (flowStatus === 'tx_error') {
      return 'error'
    } else if (flowStatus === 'polling_error' || flowStatus === 'polling_timeout' || flowStatus === 'cancelled') {
      return 'undetermined'
    } else if (flowStatus === 'user_action_required') {
      return 'user_action_required'
    }
  }
  // Fallback to top-level status
  return tx.status
}

/**
 * Enhanced transaction interface for storage.
 * Extends TrackedTransaction with additional metadata for rich display.
 */
export interface StoredTransaction extends TrackedTransaction {
  /** Deposit-specific metadata */
  depositDetails?: DepositTransactionDetails
  /** Deposit transaction data (includes forwarding address, contract addresses, etc.) */
  depositData?: DepositTxData
  /** Payment-specific metadata */
  paymentDetails?: PaymentTransactionDetails
  /**
   * Block height where the transaction was included (for Namada transactions).
   * Extracted from the broadcast response.
   */
  blockHeight?: string
  /**
   * Timestamp when client-side polling timeout occurred (milliseconds since epoch).
   * Set when the client-side polling timeout is reached but backend is still tracking the transaction.
   * This allows UI to display a warning indicator that polling has stopped while backend continues tracking.
   * Cleared when polling resumes (e.g., on page refresh).
   */
  clientTimeoutAt?: number
  /**
   * Client-side stages that occur before backend registration or are ephemeral.
   * These stages are stored locally and prepended when displaying transaction status.
   * Examples: wallet_signing, wallet_broadcasting, gasless_quote_pending
   */
  clientStages?: ChainStage[]
  /**
   * Frontend polling state for resumable chain polling.
   * Contains per-chain status, errors, timeouts, and polling parameters.
   */
  pollingState?: PollingState
  /** Last update timestamp (for sorting and filtering) */
  updatedAt: number
}

const STORAGE_KEY = 'unified-transactions'

/**
 * Unified Transaction Storage Service
 * 
 * Singleton service for managing all transaction data in localStorage.
 */
class TransactionStorageService {
  /**
   * Save a transaction to storage.
   * If transaction with same ID exists, it will be updated.
   */
  saveTransaction(tx: StoredTransaction): void {
    try {
      const allTxs = this.getAllTransactions()
      
      // Remove existing transaction with same ID
      const filtered = allTxs.filter((t) => t.id !== tx.id)
      
      // Add updated transaction with current timestamp
      const updatedTx: StoredTransaction = {
        ...tx,
        updatedAt: Date.now(),
      }
      
      const updated = [updatedTx, ...filtered]
      saveItem(STORAGE_KEY, updated)
      
      logger.debug('[TransactionStorageService] Saved transaction', {
        txId: tx.id,
        direction: tx.direction,
        status: tx.status,
      })
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to save transaction', {
        txId: tx.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Get a transaction by ID.
   */
  getTransaction(id: string): StoredTransaction | null {
    try {
      const allTxs = this.getAllTransactions()
      return allTxs.find((tx) => tx.id === id) || null
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to get transaction', {
        id,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Get all transactions, ordered by most recent first (createdAt descending).
   * Uses createdAt to maintain chronological order regardless of status updates.
   */
  getAllTransactions(): StoredTransaction[] {
    try {
      const stored = loadItem<StoredTransaction[]>(STORAGE_KEY)
      if (!stored) return []
      
      // Sort by createdAt descending (most recent first) to maintain chronological order
      return stored.sort((a, b) => {
        return b.createdAt - a.createdAt
      })
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to load transactions', {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  /**
   * Update an existing transaction with partial updates.
   */
  updateTransaction(id: string, updates: Partial<StoredTransaction>): void {
    try {
      const tx = this.getTransaction(id)
      if (!tx) {
        logger.warn('[TransactionStorageService] Transaction not found for update', { id })
        return
      }

      const updatedTx: StoredTransaction = {
        ...tx,
        ...updates,
        updatedAt: Date.now(),
      }

      this.saveTransaction(updatedTx)
      
      logger.debug('[TransactionStorageService] Updated transaction', {
        id,
        updates: Object.keys(updates),
      })
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to update transaction', {
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Delete a transaction from storage.
   */
  deleteTransaction(id: string): void {
    try {
      const allTxs = this.getAllTransactions()
      const filtered = allTxs.filter((tx) => tx.id !== id)
      saveItem(STORAGE_KEY, filtered)
      
      logger.debug('[TransactionStorageService] Deleted transaction', { id })
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to delete transaction', {
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Get all in-progress transactions.
   * In-progress: status is 'submitting' or 'broadcasted' AND flowStatus is 'pending' (or no flowStatus).
   * Note: 'undetermined' status is NOT considered in-progress (it's a final state indicating timeout).
   */
  getInProgressTransactions(): StoredTransaction[] {
    const allTxs = this.getAllTransactions()
    // Use effective status to determine if transaction is in-progress
    return allTxs.filter((tx) => {
      const effectiveStatus = getEffectiveStatusForFilter(tx)
      // Check if effective status is in-progress
      return (
        effectiveStatus === 'submitting' ||
        effectiveStatus === 'broadcasted' ||
        effectiveStatus === 'building' ||
        effectiveStatus === 'signing' ||
        effectiveStatus === 'connecting-wallet'
      )
    })
  }

  /**
   * Get completed transactions (success, error, or undetermined).
   * Optionally limit the number of results.
   */
  getCompletedTransactions(limit?: number): StoredTransaction[] {
    const allTxs = this.getAllTransactions()
    const completed = allTxs.filter((tx) => {
      // Check if transaction is in a final state (including 'undetermined')
      const isFinalStatus = tx.status === 'finalized' || tx.status === 'error' || tx.status === 'undetermined'
      
      if (isFinalStatus) return true
      
      return false
    })
    
    return limit ? completed.slice(0, limit) : completed
  }

  /**
   * Clear all transactions from storage.
   * Use with caution - this will delete all transaction history.
   */
  clearAll(): void {
    try {
      deleteItem(STORAGE_KEY)
      logger.info('[TransactionStorageService] Cleared all transactions')
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to clear transactions', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Get transaction count.
   */
  getCount(): number {
    return this.getAllTransactions().length
  }


  /**
   * Get transaction by localId (from flowMetadata).
   * Useful for looking up transactions when only localId is known.
   */
  getTransactionByLocalId(localId: string): StoredTransaction | null {
    try {
      const allTxs = this.getAllTransactions()
      return allTxs.find((tx) => tx.flowMetadata?.localId === localId) || null
    } catch (error) {
      logger.error('[TransactionStorageService] Failed to get transaction by localId', {
        localId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}

// Export singleton instance
export const transactionStorageService = new TransactionStorageService()


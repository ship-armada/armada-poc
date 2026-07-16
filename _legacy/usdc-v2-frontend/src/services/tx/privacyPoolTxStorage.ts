/**
 * Privacy Pool Transaction Storage Service
 *
 * Simplified transaction storage for EVM-only privacy pool operations.
 * Uses localStorage for persistence with in-memory caching.
 */

import type {
  StoredTransaction,
  TxStatus,
  TxStage,
  FlowType,
  CCTPMetadata,
} from '@/types/transaction'
import {
  updateStage,
  confirmStageAndAdvance,
  completeTransaction,
  failTransaction,
} from '@/types/transaction'

// ============ Constants ============

const STORAGE_KEY = 'privacy-pool-transactions'
const MAX_TRANSACTIONS = 100 // Keep last 100 transactions

// ============ In-Memory Cache ============

let transactionCache: Map<string, StoredTransaction> | null = null

/**
 * Initialize cache from localStorage
 */
function initCache(): Map<string, StoredTransaction> {
  if (transactionCache) return transactionCache

  transactionCache = new Map()

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const transactions: StoredTransaction[] = JSON.parse(stored)
      transactions.forEach((tx) => {
        transactionCache!.set(tx.id, tx)
      })
    }
  } catch (error) {
    console.error('[tx-storage] Failed to load transactions from localStorage:', error)
  }

  return transactionCache
}

/**
 * Persist cache to localStorage
 */
function persistCache(): void {
  const cache = initCache()

  try {
    // Convert to array and sort by createdAt (newest first)
    const transactions = Array.from(cache.values()).sort(
      (a, b) => b.createdAt - a.createdAt,
    )

    // Trim to max size
    const trimmed = transactions.slice(0, MAX_TRANSACTIONS)

    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))

    // Update cache if trimmed
    if (trimmed.length < transactions.length) {
      transactionCache = new Map(trimmed.map((tx) => [tx.id, tx]))
    }
  } catch (error) {
    console.error('[tx-storage] Failed to persist transactions:', error)
  }
}

// ============ CRUD Operations ============

/**
 * Save a new transaction
 */
export function saveTransaction(tx: StoredTransaction): void {
  const cache = initCache()
  cache.set(tx.id, tx)
  persistCache()
  console.log('[tx-storage] Saved transaction:', tx.id, tx.flowType)
}

/**
 * Deep clone a transaction to prevent mutation of cached data
 */
function cloneTransaction(tx: StoredTransaction): StoredTransaction {
  return {
    ...tx,
    txHashes: { ...tx.txHashes },
    stages: tx.stages.map((stage) => ({ ...stage })),
    cctp: tx.cctp ? { ...tx.cctp } : undefined,
  }
}

/**
 * Get a transaction by ID
 */
export function getTransaction(id: string): StoredTransaction | undefined {
  const cache = initCache()
  const tx = cache.get(id)
  // Return a clone to prevent mutation of cached data
  return tx ? cloneTransaction(tx) : undefined
}

/**
 * Get all transactions, sorted by creation time (newest first)
 */
export function getAllTransactions(): StoredTransaction[] {
  const cache = initCache()
  // Return clones to prevent mutation of cached data
  return Array.from(cache.values())
    .map(cloneTransaction)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Get transactions filtered by status
 */
export function getTransactionsByStatus(status: TxStatus): StoredTransaction[] {
  return getAllTransactions().filter((tx) => tx.status === status)
}

/**
 * Get transactions filtered by flow type
 */
export function getTransactionsByFlowType(flowType: FlowType): StoredTransaction[] {
  return getAllTransactions().filter((tx) => tx.flowType === flowType)
}

/**
 * Get pending (in-progress) transactions
 */
export function getPendingTransactions(): StoredTransaction[] {
  return getTransactionsByStatus('pending')
}

/**
 * Get completed transactions (success or error)
 */
export function getCompletedTransactions(): StoredTransaction[] {
  return getAllTransactions().filter(
    (tx) => tx.status === 'success' || tx.status === 'error',
  )
}

/**
 * Update a transaction
 */
export function updateTransaction(
  id: string,
  updates: Partial<StoredTransaction>,
): StoredTransaction | undefined {
  const cache = initCache()
  const existing = cache.get(id)

  if (!existing) {
    console.warn('[tx-storage] Transaction not found:', id)
    return undefined
  }

  const updated: StoredTransaction = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  }

  cache.set(id, updated)
  persistCache()

  return updated
}

/**
 * Delete a transaction
 */
export function deleteTransaction(id: string): boolean {
  const cache = initCache()
  const deleted = cache.delete(id)

  if (deleted) {
    persistCache()
    console.log('[tx-storage] Deleted transaction:', id)
  }

  return deleted
}

/**
 * Clear all transactions
 */
export function clearAllTransactions(): void {
  transactionCache = new Map()
  localStorage.removeItem(STORAGE_KEY)
  console.log('[tx-storage] Cleared all transactions')
}

// ============ Stage Update Operations ============

/**
 * Update a specific stage in a transaction
 */
export function updateTxStage(
  txId: string,
  stageId: string,
  updates: Partial<TxStage>,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  const updated = updateStage(tx, stageId, updates)
  return updateTransaction(txId, updated)
}

/**
 * Mark a stage as confirmed and advance to next stage
 */
export function confirmTxStage(
  txId: string,
  stageId: string,
  metadata?: Partial<TxStage>,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  const updated = confirmStageAndAdvance(tx, stageId, metadata)
  return updateTransaction(txId, updated)
}

/**
 * Mark transaction as completed successfully
 */
export function completeTx(txId: string): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  const updated = completeTransaction(tx)
  return updateTransaction(txId, updated)
}

/**
 * Mark transaction as failed
 */
export function failTx(
  txId: string,
  errorMessage: string,
  failedStageId?: string,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  const updated = failTransaction(tx, errorMessage, failedStageId)
  return updateTransaction(txId, updated)
}

// ============ Transaction Hash Operations ============

/**
 * Set the main transaction hash
 */
export function setMainTxHash(
  txId: string,
  txHash: string,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  return updateTransaction(txId, {
    txHashes: { ...tx.txHashes, main: txHash },
  })
}

/**
 * Set the approval transaction hash
 */
export function setApprovalTxHash(
  txId: string,
  txHash: string,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  return updateTransaction(txId, {
    txHashes: { ...tx.txHashes, approval: txHash },
  })
}

/**
 * Set the relay transaction hash (for cross-chain)
 */
export function setRelayTxHash(
  txId: string,
  txHash: string,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  return updateTransaction(txId, {
    txHashes: { ...tx.txHashes, relay: txHash },
  })
}

// ============ CCTP Metadata Operations ============

/**
 * Update CCTP metadata
 */
export function updateCCTPMetadata(
  txId: string,
  cctpUpdates: Partial<CCTPMetadata>,
): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) return undefined

  return updateTransaction(txId, {
    cctp: { ...tx.cctp, ...cctpUpdates },
  })
}

// ============ Query Helpers ============

/**
 * Find transaction by main tx hash
 */
export function findByTxHash(txHash: string): StoredTransaction | undefined {
  return getAllTransactions().find(
    (tx) =>
      tx.txHashes.main === txHash ||
      tx.txHashes.approval === txHash ||
      tx.txHashes.relay === txHash,
  )
}

/**
 * Get recent transactions (last N)
 */
export function getRecentTransactions(limit: number = 10): StoredTransaction[] {
  return getAllTransactions().slice(0, limit)
}

/**
 * Check if there are any pending transactions
 */
export function hasPendingTransactions(): boolean {
  return getPendingTransactions().length > 0
}

// ============ Repair Helpers ============

/**
 * Completed message for each stage type
 * Used when repairing transactions to fix stale "waiting..." messages
 */
const COMPLETED_STAGE_MESSAGES: Record<string, string> = {
  // Shield stages
  approval_pending: 'Approval transaction confirmed',
  approval_confirmed: 'Approval confirmed',
  shield_pending: 'Shield signature received',
  shield_submitted: 'Shield transaction confirmed',
  shield_confirmed: 'Shield confirmed on-chain',
  balance_updating: 'Balance updated',
  // Transfer stages
  proof_generating: 'Proof generated',
  transfer_pending: 'Transfer signature received',
  transfer_submitted: 'Transfer transaction confirmed',
  transfer_confirmed: 'Transfer confirmed on-chain',
  // Unshield stages
  unshield_pending: 'Unshield signature received',
  unshield_submitted: 'Unshield transaction confirmed',
  unshield_confirmed: 'Unshield confirmed on-chain',
  // CCTP stages
  cctp_burn_pending: 'CCTP burn signature received',
  cctp_burn_submitted: 'CCTP burn confirmed',
  cctp_burn_confirmed: 'Burn confirmed',
  cctp_attestation_pending: 'Attestation received',
  cctp_attestation_received: 'Attestation confirmed',
  cctp_relay_pending: 'Relay completed',
  cctp_mint_confirmed: 'USDC minted',
  // Final stages
  completed: 'Transaction completed',
}

/**
 * Repair a completed transaction's stage statuses
 *
 * This fixes transactions that completed successfully but have
 * intermediate stages stuck in 'active' or 'pending' state.
 * All stages (except 'failed') will be marked as 'confirmed'.
 * Also fixes stale "waiting..." messages with completion messages.
 */
export function repairTransaction(txId: string): StoredTransaction | undefined {
  const tx = getTransaction(txId)
  if (!tx) {
    console.warn('[tx-storage] Cannot repair: transaction not found:', txId)
    return undefined
  }

  // Only repair completed (success) transactions
  if (tx.status !== 'success') {
    console.warn('[tx-storage] Cannot repair: transaction not completed:', txId, tx.status)
    return undefined
  }

  const now = Date.now()

  // Mark all stages as confirmed (except 'failed') and fix stale messages
  const repairedStages = tx.stages.map((stage) => {
    if (stage.id === 'failed') {
      return stage
    }
    if (stage.status !== 'confirmed' && stage.status !== 'error') {
      const completedMessage = COMPLETED_STAGE_MESSAGES[stage.id]
      return {
        ...stage,
        status: 'confirmed' as const,
        timestamp: stage.timestamp || now,
        message: completedMessage || stage.message,
      }
    }
    // Also fix stale messages for already-confirmed stages
    if (stage.status === 'confirmed' && stage.message?.toLowerCase().includes('waiting')) {
      const completedMessage = COMPLETED_STAGE_MESSAGES[stage.id]
      if (completedMessage) {
        return {
          ...stage,
          message: completedMessage,
        }
      }
    }
    return stage
  })

  const updated = updateTransaction(txId, {
    stages: repairedStages,
    currentStageId: 'completed',
  })

  if (updated) {
    console.log('[tx-storage] Repaired transaction stages:', txId)
  }

  return updated
}

/**
 * Repair all completed transactions
 *
 * Useful for fixing all existing transactions after a bug fix.
 */
export function repairAllTransactions(): number {
  const completedTxs = getAllTransactions().filter((tx) => tx.status === 'success')
  let repairedCount = 0

  for (const tx of completedTxs) {
    // Check if any stages need repair
    const needsRepair = tx.stages.some(
      (stage) =>
        stage.id !== 'failed' &&
        stage.status !== 'confirmed' &&
        stage.status !== 'error',
    )

    if (needsRepair) {
      const repaired = repairTransaction(tx.id)
      if (repaired) {
        repairedCount++
      }
    }
  }

  console.log('[tx-storage] Repaired', repairedCount, 'transactions')
  return repairedCount
}

// ============ Debug Helpers ============

/**
 * Export all transactions as JSON (for debugging)
 */
export function exportTransactions(): string {
  return JSON.stringify(getAllTransactions(), null, 2)
}

/**
 * Import transactions from JSON (for debugging)
 */
export function importTransactions(json: string): void {
  try {
    const transactions: StoredTransaction[] = JSON.parse(json)
    transactionCache = new Map(transactions.map((tx) => [tx.id, tx]))
    persistCache()
    console.log('[tx-storage] Imported', transactions.length, 'transactions')
  } catch (error) {
    console.error('[tx-storage] Failed to import transactions:', error)
    throw error
  }
}

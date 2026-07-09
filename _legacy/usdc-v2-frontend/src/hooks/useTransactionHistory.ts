/**
 * Transaction History Hook
 *
 * Provides access to transaction history with real-time updates
 * for pending transactions.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { StoredTransaction, FlowType, TxStatus } from '@/types/transaction'
import {
  getAllTransactions,
  getTransaction,
  deleteTransaction,
  clearAllTransactions,
  repairTransaction,
  repairAllTransactions,
} from '@/services/tx'

// ============ Types ============

export interface UseTransactionHistoryReturn {
  /** All transactions, sorted by creation time (newest first) */
  transactions: StoredTransaction[]
  /** Pending transactions only */
  pendingTransactions: StoredTransaction[]
  /** Whether there are pending transactions */
  hasPending: boolean
  /** Get a specific transaction by ID */
  getTransactionById: (id: string) => StoredTransaction | undefined
  /** Delete a transaction */
  removeTransaction: (id: string) => void
  /** Clear all transaction history */
  clearHistory: () => void
  /** Manually refresh the transaction list */
  refresh: () => void
  /** Filter transactions by flow type */
  filterByFlowType: (flowType: FlowType) => StoredTransaction[]
  /** Filter transactions by status */
  filterByStatus: (status: TxStatus) => StoredTransaction[]
  /** Repair a single transaction's stage statuses */
  repairTx: (id: string) => StoredTransaction | undefined
  /** Repair all completed transactions */
  repairAll: () => number
}

export interface UseTransactionHistoryOptions {
  /** Auto-refresh interval for pending transactions (ms). Set to 0 to disable. */
  refreshInterval?: number
  /** Maximum number of transactions to keep in state */
  maxTransactions?: number
}

// ============ Hook ============

/**
 * Hook for accessing transaction history
 */
export function useTransactionHistory(
  options: UseTransactionHistoryOptions = {},
): UseTransactionHistoryReturn {
  const { refreshInterval = 2000, maxTransactions = 50 } = options

  const [transactions, setTransactions] = useState<StoredTransaction[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load transactions
  const loadTransactions = useCallback(() => {
    const allTx = getAllTransactions()
    setTransactions(allTx.slice(0, maxTransactions))
  }, [maxTransactions])

  // Initial load
  useEffect(() => {
    loadTransactions()
  }, [loadTransactions])

  // Auto-refresh for pending transactions
  useEffect(() => {
    if (refreshInterval <= 0) return

    // Only set up interval if there are pending transactions
    const pending = transactions.filter((tx) => tx.status === 'pending')
    if (pending.length === 0) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    intervalRef.current = setInterval(() => {
      loadTransactions()
    }, refreshInterval)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [transactions, refreshInterval, loadTransactions])

  // Derived state
  const pendingTransactions = transactions.filter((tx) => tx.status === 'pending')
  const hasPending = pendingTransactions.length > 0

  // Actions
  const getTransactionById = useCallback((id: string) => {
    return getTransaction(id)
  }, [])

  const removeTransaction = useCallback(
    (id: string) => {
      deleteTransaction(id)
      loadTransactions()
    },
    [loadTransactions],
  )

  const clearHistory = useCallback(() => {
    clearAllTransactions()
    setTransactions([])
  }, [])

  const refresh = useCallback(() => {
    loadTransactions()
  }, [loadTransactions])

  const filterByFlowType = useCallback(
    (flowType: FlowType) => {
      return transactions.filter((tx) => tx.flowType === flowType)
    },
    [transactions],
  )

  const filterByStatus = useCallback(
    (status: TxStatus) => {
      return transactions.filter((tx) => tx.status === status)
    },
    [transactions],
  )

  const repairTx = useCallback(
    (id: string) => {
      const repaired = repairTransaction(id)
      if (repaired) {
        loadTransactions()
      }
      return repaired
    },
    [loadTransactions],
  )

  const repairAll = useCallback(() => {
    const count = repairAllTransactions()
    if (count > 0) {
      loadTransactions()
    }
    return count
  }, [loadTransactions])

  return {
    transactions,
    pendingTransactions,
    hasPending,
    getTransactionById,
    removeTransaction,
    clearHistory,
    refresh,
    filterByFlowType,
    filterByStatus,
    repairTx,
    repairAll,
  }
}

// ============ Single Transaction Hook ============

export interface UseTransactionReturn {
  /** The transaction, if found */
  transaction: StoredTransaction | undefined
  /** Whether the transaction is loading */
  isLoading: boolean
  /** Refresh the transaction */
  refresh: () => void
}

/**
 * Hook for tracking a single transaction by ID
 */
export function useTransaction(
  txId: string | undefined,
  refreshInterval: number = 2000,
): UseTransactionReturn {
  const [transaction, setTransaction] = useState<StoredTransaction | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadTransaction = useCallback(() => {
    if (!txId) {
      setTransaction(undefined)
      setIsLoading(false)
      return
    }

    const tx = getTransaction(txId)
    setTransaction(tx)
    setIsLoading(false)
  }, [txId])

  // Initial load
  useEffect(() => {
    setIsLoading(true)
    loadTransaction()
  }, [loadTransaction])

  // Auto-refresh for pending transactions
  useEffect(() => {
    if (!transaction || transaction.status !== 'pending' || refreshInterval <= 0) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    intervalRef.current = setInterval(() => {
      loadTransaction()
    }, refreshInterval)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [transaction, refreshInterval, loadTransaction])

  return {
    transaction,
    isLoading,
    refresh: loadTransaction,
  }
}

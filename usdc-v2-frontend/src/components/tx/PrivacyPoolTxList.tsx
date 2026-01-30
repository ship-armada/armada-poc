/**
 * Privacy Pool Transaction List
 *
 * Displays a list of Privacy Pool transactions (shield, transfer, unshield)
 * with filtering by status.
 */

import { useState, useCallback } from 'react'
import type { StoredTransaction } from '@/types/transaction'
import { useTransactionHistory } from '@/hooks/useTransactionHistory'
import { PrivacyPoolTxCard } from './PrivacyPoolTxCard'
import { PrivacyPoolTxDetailModal } from './PrivacyPoolTxDetailModal'

// ============ Types ============

export interface PrivacyPoolTxListProps {
  /** Filter transactions by status */
  statusFilter?: 'pending' | 'completed' | 'all'
  /** Maximum number of transactions to display */
  limit?: number
  /** Hide action menus */
  hideActions?: boolean
  /** Custom empty state message */
  emptyMessage?: string
  /** Custom class name */
  className?: string
}

// ============ Component ============

export function PrivacyPoolTxList({
  statusFilter = 'all',
  limit = 10,
  hideActions: _hideActions = false,
  emptyMessage,
  className = '',
}: PrivacyPoolTxListProps) {
  const { transactions, pendingTransactions, refresh } = useTransactionHistory()
  const [selectedTx, setSelectedTx] = useState<StoredTransaction | null>(null)

  // Filter transactions based on status
  const filtered = (() => {
    switch (statusFilter) {
      case 'pending':
        return pendingTransactions
      case 'completed':
        return transactions.filter(
          (tx) => tx.status === 'success' || tx.status === 'error' || tx.status === 'cancelled',
        )
      default:
        return transactions
    }
  })()

  // Apply limit
  const display = filtered.slice(0, limit)

  const handleTransactionClick = useCallback((tx: StoredTransaction) => {
    setSelectedTx(tx)
  }, [])

  const handleCloseModal = useCallback(() => {
    setSelectedTx(null)
  }, [])

  const handleRepair = useCallback(
    (repairedTx: StoredTransaction) => {
      // Update the selected transaction with repaired data
      setSelectedTx(repairedTx)
      // Refresh the transaction list to show updated data
      refresh()
    },
    [refresh],
  )

  // Empty state
  if (display.length === 0) {
    const defaultMessage =
      statusFilter === 'pending'
        ? 'No transactions in progress'
        : statusFilter === 'completed'
          ? 'No completed transactions'
          : 'No transactions yet'

    return (
      <div className={`text-sm text-muted-foreground py-4 ${className}`}>
        {emptyMessage || defaultMessage}
      </div>
    )
  }

  return (
    <>
      <div className={`space-y-2 ${className}`}>
        {display.map((tx) => (
          <PrivacyPoolTxCard
            key={tx.id}
            transaction={tx}
            onClick={handleTransactionClick}
            className="cursor-pointer"
          />
        ))}
      </div>

      {/* Detail modal */}
      <PrivacyPoolTxDetailModal
        transaction={selectedTx}
        isOpen={!!selectedTx}
        onClose={handleCloseModal}
        onRepair={handleRepair}
      />
    </>
  )
}

// ============ Section Wrapper ============

export interface PrivacyPoolTxSectionProps {
  title: string
  statusFilter: 'pending' | 'completed' | 'all'
  limit?: number
  emptyMessage?: string
}

/**
 * A section wrapper that includes a title and the transaction list
 */
export function PrivacyPoolTxSection({
  title,
  statusFilter,
  limit = 5,
  emptyMessage,
}: PrivacyPoolTxSectionProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <PrivacyPoolTxList
        statusFilter={statusFilter}
        limit={limit}
        emptyMessage={emptyMessage}
        hideActions
      />
    </div>
  )
}

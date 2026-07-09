import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAtomValue } from 'jotai'
import type { StoredTransaction } from '@/types/transaction'
import { getAllTransactions, deleteTransaction as deletePrivacyPoolTx } from '@/services/tx/privacyPoolTxStorage'
import { TransactionCard } from './TransactionCard'
import { Spinner } from '@/components/common/Spinner'
import { useTxAnimationState } from '@/hooks/useTxAnimationState'
import { txAnimationAtom } from '@/atoms/txAnimationAtom'

/**
 * Check if a transaction is in progress (pending status)
 */
function isInProgress(tx: StoredTransaction): boolean {
  return tx.status === 'pending'
}

export interface TxInProgressListProps {
  openModalTxId?: string | null
  onModalOpenChange?: (txId: string | null) => void
  hideActions?: boolean // Hide the actions column (dropdown menu)
}

// Helper component to render a transaction with animation
function TxInProgressItem({
  tx,
  onDelete,
  hideActions,
  isModalOpen,
  onModalOpenChange,
}: {
  tx: StoredTransaction
  onDelete: (txId: string) => void
  hideActions: boolean
  isModalOpen: boolean
  onModalOpenChange: (open: boolean) => void
}) {
  const animationMap = useAtomValue(txAnimationAtom)
  const animationState = animationMap.get(tx.id)
  
  // Determine target opacity based on phase - let Framer Motion animate the transition
  // When phase is 'exitingInProgress', animate to 0, otherwise stay at 1
  const targetOpacity = animationState?.phase === 'exitingInProgress' ? 0 : 1

  return (
    <motion.div
      animate={{ opacity: targetOpacity }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <TransactionCard
        transaction={tx}
        variant="compact"
        showExpandButton={true}
        onDelete={onDelete}
        hideActions={hideActions}
        isModalOpen={isModalOpen}
        onModalOpenChange={onModalOpenChange}
      />
    </motion.div>
  )
}

export function TxInProgressList({ openModalTxId, onModalOpenChange, hideActions = false }: TxInProgressListProps = {}) {
  // Initialize animation state management
  useTxAnimationState()
  
  const [inProgressTxs, setInProgressTxs] = useState<StoredTransaction[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const animationMap = useAtomValue(txAnimationAtom)

  const loadTransactions = useCallback(() => {
    try {
      // Load ALL transactions from new Privacy Pool storage
      const allTxs = getAllTransactions()
      setInProgressTxs(allTxs)
      setIsLoading(false)
      setError(null)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load transactions'
      console.error('[TxInProgressList] Failed to load transactions', err)
      setError(errorMessage)
      setIsLoading(false)
    }
  }, [])

  // Load in-progress transactions from unified storage
  useEffect(() => {
    // Load initially
    loadTransactions()

    // Reload periodically to catch updates (optimized: 5 seconds for in-progress)
    const interval = setInterval(loadTransactions, 5000)
    return () => clearInterval(interval)
  }, [loadTransactions])

  const handleDelete = useCallback(
    (txId: string) => {
      try {
        deletePrivacyPoolTx(txId)
        // Refresh the list after deletion
        loadTransactions()
      } catch (err) {
        console.error('[TxInProgressList] Failed to delete transaction', err)
      }
    },
    [loadTransactions],
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Spinner label="Loading transactions..." />
      </div>
    )
  }

  if (error) {
    return (
      <div className="card card-error card-sm rounded-md text-sm text-error">
        <p className="font-medium">Error loading transactions</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    )
  }

  // Filter transactions to show only those in inProgress or exitingInProgress phases
  // This allows transactions to remain in the list during the exit animation
  // even if their status has changed to completed
  const displayTxs = inProgressTxs.filter(tx => {
    const animationState = animationMap.get(tx.id)
    if (!animationState) {
      // If no animation state, check if transaction is actually in-progress
      // This handles initial load before animation state is initialized
      return isInProgress(tx)
    }
    return animationState.phase === 'inProgress' || animationState.phase === 'exitingInProgress'
  })

  if (displayTxs.length === 0) {
    return (
      <div className="text-sm text-muted-foreground min-h-20">
        No transactions in progress.
      </div>
    )
  }

  return (
    <div className="space-y-2 min-h-20">
      <AnimatePresence mode="popLayout">
        {displayTxs.map((tx) => (
          <TxInProgressItem
            key={tx.id}
            tx={tx}
            onDelete={handleDelete}
            hideActions={hideActions}
            isModalOpen={openModalTxId === tx.id}
            onModalOpenChange={(open) => {
              if (onModalOpenChange) {
                onModalOpenChange(open ? tx.id : null)
              }
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

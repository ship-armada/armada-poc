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
 * Check if a transaction is completed (success, error, or cancelled)
 */
function isCompleted(tx: StoredTransaction): boolean {
  return tx.status === 'success' || tx.status === 'error' || tx.status === 'cancelled'
}

export interface TxHistoryListProps {
  openModalTxId?: string | null
  onModalOpenChange?: (txId: string | null) => void
  reloadTrigger?: number // When changed, triggers immediate reload
  hideActions?: boolean // Hide the actions column (dropdown menu)
}

// Helper component to render a transaction with animation
function TxHistoryItem({
  tx,
  index,
  totalCount,
  onDelete,
  hideActions,
  isModalOpen,
  onModalOpenChange,
}: {
  tx: StoredTransaction
  index: number
  totalCount: number
  onDelete: (txId: string) => void
  hideActions: boolean
  isModalOpen: boolean
  onModalOpenChange: (open: boolean) => void
}) {
  const animationMap = useAtomValue(txAnimationAtom)
  const animationState = animationMap.get(tx.id)
  
  // Drive opacity purely from phase - let Framer Motion animate the transition
  // When phase is 'enteringHistory', opacity = 0 (starting state)
  // When phase changes to 'inHistory', Framer Motion animates 0 → 1 (fade-in)
  // The fade-in animation happens when enteringHistory ends (transitions to inHistory)
  const targetOpacity = animationState?.phase === 'enteringHistory' ? 0 : 1

  return (
    <motion.div
      initial={false}
      animate={{ opacity: targetOpacity }}
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
      {/* Add divider between items, but not after the last one */}
      {index < totalCount - 1 && (
        <div className="border-b border-border/60 my-2" />
      )}
    </motion.div>
  )
}

export function TxHistoryList({ openModalTxId, onModalOpenChange, reloadTrigger, hideActions = false }: TxHistoryListProps = {}) {
  // Initialize animation state management
  useTxAnimationState()
  
  const [completedTxs, setCompletedTxs] = useState<StoredTransaction[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const animationMap = useAtomValue(txAnimationAtom)

  const loadTransactions = useCallback(() => {
    try {
      // Load ALL transactions from new Privacy Pool storage
      const allTxs = getAllTransactions()
      setCompletedTxs(allTxs)
      setIsLoading(false)
      setError(null)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load transactions'
      console.error('[TxHistoryList] Failed to load transactions', err)
      setError(errorMessage)
      setIsLoading(false)
    }
  }, [])

  // Load completed transactions from unified storage (limit to 5 most recent)
  useEffect(() => {
    // Load initially
    loadTransactions()

    // Reload periodically to catch updates (synchronized: 5 seconds to match In Progress)
    const interval = setInterval(loadTransactions, 5000)
    return () => clearInterval(interval)
  }, [loadTransactions])

  // Trigger immediate reload when reloadTrigger changes (for coordination with In Progress)
  useEffect(() => {
    if (reloadTrigger !== undefined && reloadTrigger > 0) {
      loadTransactions()
    }
  }, [reloadTrigger, loadTransactions])

  const handleDelete = useCallback(
    (txId: string) => {
      try {
        deletePrivacyPoolTx(txId)
        // Refresh the list after deletion
        loadTransactions()
      } catch (err) {
        console.error('[TxHistoryList] Failed to delete transaction', err)
      }
    },
    [loadTransactions],
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Spinner label="Loading history..." />
      </div>
    )
  }

  if (error) {
    return (
      <div className="card card-error card-sm rounded-md text-sm text-error">
        <p className="font-medium">Error loading history</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    )
  }

  if (completedTxs.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        History will appear after your first transaction.
      </div>
    )
  }

  // Filter transactions to show only those in enteringHistory or inHistory phases
  // This allows transactions to appear in the list during the enter animation
  // even if they're still transitioning from in-progress status
  const displayTxs = completedTxs.filter(tx => {
    const animationState = animationMap.get(tx.id)
    if (!animationState) {
      // If no animation state, check if transaction is actually completed
      // This handles initial load before animation state is initialized
      return isCompleted(tx)
    }
    return animationState.phase === 'enteringHistory' || animationState.phase === 'inHistory'
  }).slice(0, 5) // Limit to 5 most recent for history display

  return (
    <div className="space-y-0">
      <AnimatePresence>
        {displayTxs.map((tx, index) => (
          <TxHistoryItem
            key={tx.id}
            tx={tx}
            index={index}
            totalCount={displayTxs.length}
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

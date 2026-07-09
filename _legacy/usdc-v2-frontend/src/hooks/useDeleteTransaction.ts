import { useCallback } from 'react'
import { useAtom } from 'jotai'
import { txAtom } from '@/atoms/txAtom'
import { transactionStorageService } from '@/services/tx/transactionStorageService'
import { logger } from '@/utils/logger'

/**
 * Hook for deleting transactions from both storage and state.
 * Ensures clean removal from localStorage and txAtom state.
 */
export function useDeleteTransaction() {
  const [, setTxState] = useAtom(txAtom)

  const deleteTransaction = useCallback(
    (txId: string) => {
      try {
        // Delete from storage first
        transactionStorageService.deleteTransaction(txId)
        
        logger.debug('[useDeleteTransaction] Transaction deleted from storage', { txId })

        // Update state atom to remove from history and activeTransaction
        setTxState((state) => {
          const updatedHistory = state.history.filter((tx) => tx.id !== txId)
          const updatedActiveTransaction =
            state.activeTransaction?.id === txId ? undefined : state.activeTransaction

          logger.info('[useDeleteTransaction] Transaction deleted successfully', {
            txId,
            remainingHistoryCount: updatedHistory.length,
          })

          return {
            activeTransaction: updatedActiveTransaction,
            history: updatedHistory,
          }
        })
      } catch (error) {
        logger.error('[useDeleteTransaction] Failed to delete transaction', {
          txId,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
    [setTxState],
  )

  return { deleteTransaction }
}


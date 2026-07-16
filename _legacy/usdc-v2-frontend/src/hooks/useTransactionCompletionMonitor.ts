import { useEffect, useRef } from 'react'
import { transactionStorageService } from '@/services/tx/transactionStorageService'

interface UseTransactionCompletionMonitorOptions {
  /** Currently open modal transaction ID (if any) */
  openModalTxId: string | null
  /** Callback when a transaction completes and triggers history reload */
  onTransactionCompleted?: () => void
  /** Polling interval in milliseconds (default: 2000) */
  intervalMs?: number
}

/**
 * Hook to monitor in-progress transactions and detect when they complete
 * 
 * Periodically checks for transactions that have moved from in-progress to completed.
 * If the currently open modal's transaction completes, triggers the onTransactionCompleted callback.
 * 
 * @param options - Monitor options
 */
export function useTransactionCompletionMonitor({
  openModalTxId,
  onTransactionCompleted,
  intervalMs = 2000,
}: UseTransactionCompletionMonitorOptions): void {
  const previousInProgressTxIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    const checkForCompletedTransactions = () => {
      const currentInProgressTxs = transactionStorageService.getInProgressTransactions()
      const currentInProgressTxIds = new Set(currentInProgressTxs.map(tx => tx.id))

      // Check if any transaction disappeared from in-progress (moved to history)
      const disappearedTxIds = Array.from(previousInProgressTxIds.current).filter(
        txId => !currentInProgressTxIds.has(txId),
      )

      // If a transaction disappeared and we have a modal open for it, trigger callback
      if (disappearedTxIds.length > 0 && openModalTxId && disappearedTxIds.includes(openModalTxId)) {
        onTransactionCompleted?.()
      }

      // Update previous set for next check
      previousInProgressTxIds.current = currentInProgressTxIds
    }

    // Check immediately on mount
    checkForCompletedTransactions()

    // Check periodically (more frequent than polling to catch transitions quickly)
    const interval = setInterval(checkForCompletedTransactions, intervalMs)
    return () => clearInterval(interval)
  }, [openModalTxId, onTransactionCompleted, intervalMs])
}

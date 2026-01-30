import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { transactionStorageService } from '@/services/tx/transactionStorageService'

/**
 * Hook to handle transaction modal opening from URL query parameter
 * 
 * When a 'tx' query parameter is present, verifies the transaction exists
 * and calls onModalOpen with the transaction ID, then removes the parameter from URL.
 * 
 * @param onModalOpen - Callback to open the transaction modal with the transaction ID
 */
export function useTransactionQueryParam(
  onModalOpen: (txId: string) => void,
): void {
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    const txId = searchParams.get('tx')
    if (txId) {
      // Verify transaction exists before opening modal
      const allTxs = [
        ...transactionStorageService.getInProgressTransactions(),
        ...transactionStorageService.getCompletedTransactions(),
      ]
      const txExists = allTxs.some(tx => tx.id === txId)

      if (txExists) {
        onModalOpen(txId)
        // Remove query parameter from URL after opening modal
        searchParams.delete('tx')
        setSearchParams(searchParams, { replace: true })
      }
    }
  }, [searchParams, setSearchParams, onModalOpen])
}

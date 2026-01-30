/**
 * Hook that automatically cleans up transaction success state when navigating
 * to non-transaction pages after the countdown has completed.
 * 
 * This ensures that the "locked" state doesn't persist indefinitely when
 * users navigate to Dashboard or other pages that don't show the transaction overlay.
 */

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAtom } from 'jotai'
import { txUiAtom, resetTxUiState } from '@/atoms/txUiAtom'

const TRANSACTION_PAGES = ['/deposit', '/send']
const COUNTDOWN_SECONDS = 3

export function useTransactionStateCleanup(): void {
  const location = useLocation()
  const [txUiState, setTxUiState] = useAtom(txUiAtom)

  useEffect(() => {
    const isTransactionPage = TRANSACTION_PAGES.some((page) =>
      location.pathname.startsWith(page)
    )

    // Only cleanup if we're on a non-transaction page and (success state OR error state) is active
    if (!isTransactionPage) {
      if (txUiState.showSuccessState && txUiState.successTimestamp) {
        const timeSinceSuccess = Date.now() - txUiState.successTimestamp
        const countdownMs = COUNTDOWN_SECONDS * 1000

        // Only clear if countdown has completed (3+ seconds since success)
        if (timeSinceSuccess >= countdownMs) {
          resetTxUiState(setTxUiState)
        }
      } else if (txUiState.errorState) {
        // Reset error state immediately when navigating away (no countdown needed)
        resetTxUiState(setTxUiState)
      }
    }
  }, [location.pathname, txUiState, setTxUiState])
}


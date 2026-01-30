/**
 * Global transaction UI state atom.
 * Manages transaction phase, status, and UI state across all transaction types.
 */

import { atom } from 'jotai'
import type { TransactionPhase } from '@/components/tx/ProgressStepper'

export interface TransactionUIState {
  phase: TransactionPhase
  isSubmitting: boolean
  txHash: string | null
  explorerUrl: string | undefined
  errorState: { message: string } | null
  showSuccessState: boolean
  successTimestamp?: number
  transactionType: 'deposit' | 'send' | 'shield' | null
}

export const txUiAtom = atom<TransactionUIState>({
  phase: null,
  isSubmitting: false,
  txHash: null,
  explorerUrl: undefined,
  errorState: null,
  showSuccessState: false,
  transactionType: null,
})

/**
 * Derived atom that returns true if any transaction is currently active.
 * Success state is excluded since the transaction is no longer in flight once it succeeds.
 */
export const isAnyTransactionActiveAtom = atom((get) => {
  const state = get(txUiAtom)
  return state.isSubmitting || state.phase !== null
})

/**
 * Helper function to reset transaction UI state.
 */
export function resetTxUiState(setTxUiState: (state: TransactionUIState) => void): void {
  setTxUiState({
    phase: null,
    isSubmitting: false,
    txHash: null,
    explorerUrl: undefined,
    errorState: null,
    showSuccessState: false,
    successTimestamp: undefined,
    transactionType: null,
  })
}


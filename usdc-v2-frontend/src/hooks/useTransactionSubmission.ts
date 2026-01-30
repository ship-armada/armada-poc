/**
 * Generic hook for transaction submission with consistent state management and error handling
 */

import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAtom } from 'jotai'
import { useTxTracker } from '@/hooks/useTxTracker'
import { useToast } from '@/hooks/useToast'
import { txUiAtom } from '@/atoms/txUiAtom'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import {
  buildTransactionSuccessToast,
  buildTransactionErrorToast,
  buildTransactionStatusToast,
  buildCopySuccessToast,
} from '@/utils/toastHelpers'
import {
  createTransactionToastId,
  handleTransactionError,
  fetchAndSetExplorerUrl,
  saveTransactionWithDetails,
} from '@/utils/transactionHelpers'
import type { TransactionType } from '@/utils/transactionHelpers'

export interface TransactionSubmissionConfig<TParams, TDetails> {
  /** Transaction type for UI state and toasts */
  transactionType: TransactionType
  /** Build transaction from parameters */
  buildTransaction: (params: TParams) => Promise<StoredTransaction>
  /** Sign transaction */
  signTransaction: (tx: StoredTransaction) => Promise<StoredTransaction>
  /** Broadcast transaction */
  broadcastTransaction: (
    tx: StoredTransaction,
    callbacks: { onSigningComplete: () => void }
  ) => Promise<{ hash: string; blockHeight?: string | number }>
  /** Save transaction with details */
  saveTransaction: (tx: StoredTransaction, details: TDetails) => Promise<StoredTransaction>
  /** Get explorer URL for transaction */
  getExplorerUrl: (chain: string | undefined, hash: string) => Promise<string>
  /** Direction for transaction ('deposit' or 'send') */
  direction: 'deposit' | 'send'
  /** Optional pre-submission hook (e.g., for validation or notifications) */
  onBeforeSubmit?: (params: TParams) => void | Promise<void>
}

export type TransactionSubmissionParams<TParams extends Record<string, unknown>, TDetails> = TParams & {
  details: TDetails
  onAddressBookSave?: () => void
}

/**
 * Generic hook for transaction submission
 * 
 * @param config - Transaction submission configuration
 * @returns Transaction submission function
 */
export function useTransactionSubmission<TParams extends Record<string, unknown>, TDetails>(
  config: TransactionSubmissionConfig<TParams, TDetails>
) {
  const navigate = useNavigate()
  const { upsertTransaction } = useTxTracker({ enablePolling: false })
  const { notify, updateToast, dismissToast } = useToast()
  const [txUiState, setTxUiState] = useAtom(txUiAtom)

  const {
    transactionType,
    buildTransaction,
    signTransaction,
    broadcastTransaction,
    saveTransaction,
    getExplorerUrl,
    direction,
    onBeforeSubmit,
  } = config

  const submit = useCallback(
    async (params: TransactionSubmissionParams<TParams, TDetails>): Promise<void> => {
      const { details, onAddressBookSave, ...txParams } = params

      // Save address to address book immediately on initiation (non-blocking)
      if (onAddressBookSave) {
        void onAddressBookSave()
      }

      // Run pre-submission hook if provided
      if (onBeforeSubmit) {
        await onBeforeSubmit(txParams as unknown as TParams)
      }

      setTxUiState({
        ...txUiState,
        isSubmitting: true,
        phase: 'building',
        errorState: null,
        txHash: null,
        explorerUrl: undefined,
        showSuccessState: false,
        transactionType,
      })

      // Track transaction state for error handling
      let tx: StoredTransaction | undefined
      let signedTx: StoredTransaction | undefined
      let currentTx: StoredTransaction | undefined

      // Use a consistent toast ID for transaction status updates
      const txToastId = createTransactionToastId(transactionType)

      try {
        // Build transaction
        notify(buildTransactionStatusToast('building', direction, txToastId))
        tx = await buildTransaction(txParams as unknown as TParams)

        // Save transaction immediately after build (for error tracking)
        currentTx = saveTransactionWithDetails(tx, details as Record<string, unknown>, upsertTransaction)

        // Sign transaction (no-op, actual signing happens during broadcast)
        setTxUiState({ ...txUiState, phase: 'signing' })
        updateToast(txToastId, buildTransactionStatusToast('signing', direction))
        signedTx = await signTransaction(tx)

        // Update status to signing
        currentTx = saveTransactionWithDetails(
          { ...currentTx, ...signedTx, status: 'signing' },
          {},
          upsertTransaction
        )

        // Broadcast transaction (signing popup appears here, so keep showing "Signing transaction...")
        // Update status to submitting after signing completes
        currentTx = saveTransactionWithDetails(
          { ...currentTx, status: 'submitting' },
          {},
          upsertTransaction
        )

        const broadcastResult = await broadcastTransaction(signedTx, {
          onSigningComplete: () => {
            // Phase 3: Submitting (only after signing is complete)
            setTxUiState({ ...txUiState, phase: 'submitting' })
            updateToast(txToastId, buildTransactionStatusToast('submitting', direction))
          },
        })

        const txHash = broadcastResult.hash
        const blockHeight = broadcastResult.blockHeight

        // Update transaction with hash and block height
        const txWithHash: StoredTransaction = {
          ...signedTx,
          hash: txHash,
          ...(blockHeight && { blockHeight: typeof blockHeight === 'number' ? String(blockHeight) : blockHeight }),
          status: 'broadcasted' as const,
        }

        // Save transaction to unified storage with details
        // Frontend polling handles all tracking (no backend registration needed)
        const savedTx = await saveTransaction(txWithHash, details)

        // Also update in-memory state for immediate UI updates
        upsertTransaction(savedTx)

        // Update the existing loading toast to success toast
        const successToast = buildTransactionSuccessToast(savedTx, {
          onViewTransaction: (id) => {
            navigate(`/dashboard?tx=${id}`)
          },
          onCopyHash: () => {
            notify(buildCopySuccessToast('Transaction hash'))
          },
        })
        const { id: _, ...successToastArgs } = successToast
        updateToast(txToastId, successToastArgs)

        // Set success state and fetch explorer URL
        setTxUiState({ ...txUiState, phase: null, txHash, showSuccessState: true, successTimestamp: Date.now() })
        const selectedChain = (txParams as { selectedChain?: string }).selectedChain
        await fetchAndSetExplorerUrl(selectedChain, txHash, setTxUiState, getExplorerUrl)
      } catch (error) {
        // Dismiss the loading toast if it exists
        dismissToast(txToastId)

        console.error(`[useTransactionSubmission:${transactionType}] Transaction submission failed:`, error)

        const selectedChain = (txParams as { selectedChain?: string }).selectedChain
        const { message, errorTx } = handleTransactionError(
          error,
          currentTx,
          tx,
          transactionType,
          selectedChain,
          details as Record<string, unknown>,
          upsertTransaction
        )

        // Show error toast with action to view transaction if available
        if (errorTx) {
          notify(
            buildTransactionErrorToast(errorTx, message, {
              onViewTransaction: (id) => {
                navigate(`/dashboard?tx=${id}`)
              },
            })
          )
        } else {
          const directionLabel = direction === 'deposit' ? 'Deposit' : 'Payment'
          notify({
            title: `${directionLabel} Failed`,
            description: message,
            level: 'error',
          })
        }

        // Set error state for enhanced error display
        setTxUiState({ ...txUiState, errorState: { message }, phase: null, isSubmitting: false })
      } finally {
        // Reset isSubmitting in global state if not already reset
        if (txUiState.isSubmitting) {
          setTxUiState((prev) => ({ ...prev, isSubmitting: false }))
        }
      }
    },
    [
      navigate,
      upsertTransaction,
      notify,
      updateToast,
      dismissToast,
      txUiState,
      setTxUiState,
      transactionType,
      buildTransaction,
      signTransaction,
      broadcastTransaction,
      saveTransaction,
      getExplorerUrl,
      direction,
      onBeforeSubmit,
    ]
  )

  return { submit }
}


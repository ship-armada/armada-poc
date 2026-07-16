/**
 * Send Transaction Hook
 *
 * Handles the complete send transaction flow including:
 * - Private transfers (0zk → 0zk)
 * - Local unshield (0zk → 0x on hub)
 * - Cross-chain unshield (0zk → 0x via CCTP)
 *
 * Manages prover initialization, proof generation progress, UI state,
 * and transaction tracking.
 */

import { useState, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { walletAtom } from '@/atoms/walletAtom'
import { useShieldedWallet } from './useShieldedWallet'
import { useToast } from './useToast'
import {
  executeSendTransaction,
  validateSendParams,
  type SendTransactionParams,
  type SendTransactionDetails,
  type SendProgress,
  type SendStage,
} from '@/services/send'
import { sanitizeError } from '@/utils/errorSanitizer'
import { parseUSDC } from '@/lib/sdk'
import {
  initTransferTransaction,
  markTransferProofGenerating,
  updateTransferProofProgress,
  markTransferProofComplete,
  markTransferPending,
  markTransferSubmitted,
  markTransferCompleted,
  markTransferFailed,
  initUnshieldTransaction,
  markUnshieldProofGenerating,
  updateUnshieldProofProgress,
  markUnshieldProofComplete,
  markUnshieldPending,
  markUnshieldSubmitted,
  markUnshieldCompleted,
  markUnshieldFailed,
  type ChainScope,
} from '@/services/tx'

// ============ Types ============

export interface UseSendTransactionParams {
  /** Amount in human readable format (e.g., "100.50") */
  amount: string
  /** Recipient address (0zk... or 0x...) */
  recipientAddress: string
  /** Type of recipient */
  recipientType: 'railgun' | 'ethereum'
  /** Destination chain for unshield (e.g., 'hub', 'client-a', 'client-b') */
  destinationChainKey?: string
  /** Called on successful send */
  onSuccess?: (details: SendTransactionDetails) => void
  /** Called on error */
  onError?: (error: Error) => void
}

export interface UseSendTransactionReturn {
  /** Submit a send transaction */
  submitSend: (params: UseSendTransactionParams) => Promise<void>
  /** Whether a send transaction is in progress */
  isSubmitting: boolean
  /** Current transaction stage */
  stage: SendStage | null
  /** Current stage message */
  stageMessage: string | null
  /** Proof generation progress (0-1) */
  proofProgress: number
  /** Last error if any */
  error: string | null
  /** Last successful transaction details */
  lastTransaction: SendTransactionDetails | null
  /** Current tracked transaction ID */
  currentTxId: string | null
}

// ============ Hook ============

export function useSendTransaction(): UseSendTransactionReturn {
  const walletState = useAtomValue(walletAtom)
  const { walletId, encryptionKey, shieldedBalance, refreshBalance } =
    useShieldedWallet()
  const { notify, updateToast, dismissToast } = useToast()

  // State
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [stage, setStage] = useState<SendStage | null>(null)
  const [stageMessage, setStageMessage] = useState<string | null>(null)
  const [proofProgress, setProofProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [lastTransaction, setLastTransaction] =
    useState<SendTransactionDetails | null>(null)
  const [currentTxId, setCurrentTxId] = useState<string | null>(null)

  // Submit send transaction
  const submitSend = useCallback(
    async (params: UseSendTransactionParams) => {
      const {
        amount,
        recipientAddress,
        recipientType,
        destinationChainKey,
        onSuccess,
        onError,
      } = params

      const evmAddress = walletState.metaMask.account

      if (!evmAddress) {
        const err = new Error('No wallet connected')
        setError(err.message)
        onError?.(err)
        return
      }

      if (!walletId || !encryptionKey) {
        const err = new Error('Shielded wallet not unlocked')
        setError(err.message)
        onError?.(err)
        return
      }

      setIsSubmitting(true)
      setError(null)
      setStage(null)
      setStageMessage(null)
      setProofProgress(0)
      setCurrentTxId(null)

      // Determine operation type for messaging
      const isPrivateTransfer = recipientType === 'railgun'
      const isCrossChain =
        !isPrivateTransfer && destinationChainKey && destinationChainKey !== 'hub'

      const operationType = isPrivateTransfer
        ? 'Transfer'
        : isCrossChain
          ? 'Cross-chain unshield'
          : 'Unshield'

      // Initialize transaction tracking
      const amountRaw = parseUSDC(amount)
      let txId: string

      if (isPrivateTransfer) {
        const trackedTx = initTransferTransaction({
          amount,
          amountRaw: amountRaw.toString(),
          tokenSymbol: 'USDC',
          senderRailgunAddress: evmAddress,
          recipientRailgunAddress: recipientAddress,
        })
        txId = trackedTx.id
      } else {
        const destChain = (destinationChainKey || 'hub') as ChainScope
        const trackedTx = initUnshieldTransaction({
          amount,
          amountRaw: amountRaw.toString(),
          tokenSymbol: 'USDC',
          railgunAddress: evmAddress,
          recipientAddress,
          destinationChain: destChain,
          isCrossChain: !!isCrossChain,
        })
        txId = trackedTx.id
      }
      setCurrentTxId(txId)

      // Show initial toast
      const toastId = notify({
        title: `Preparing ${operationType.toLowerCase()}...`,
        level: 'loading',
      })

      try {
        // Build transaction params
        const txParams: SendTransactionParams = {
          amount,
          recipientAddress,
          recipientType,
          destinationChainKey: destinationChainKey || 'hub',
        }

        // Validate params
        const validation = await validateSendParams(txParams, shieldedBalance)
        if (!validation.valid) {
          throw new Error(validation.error || 'Invalid send parameters')
        }

        // Execute the send transaction
        const details = await executeSendTransaction(
          txParams,
          walletId,
          encryptionKey,
          (progress: SendProgress) => {
            setStage(progress.stage)
            setStageMessage(progress.message)

            if (progress.proofProgress !== undefined) {
              setProofProgress(progress.proofProgress)
            }

            // Update transaction tracker based on stage
            if (isPrivateTransfer) {
              switch (progress.stage) {
                case 'generating-proof':
                  if (progress.proofProgress === 0) {
                    markTransferProofGenerating(txId)
                  } else if (progress.proofProgress !== undefined) {
                    updateTransferProofProgress(txId, progress.proofProgress)
                  }
                  break
                case 'signing':
                  markTransferProofComplete(txId)
                  markTransferPending(txId)
                  break
              }
            } else {
              switch (progress.stage) {
                case 'generating-proof':
                  if (progress.proofProgress === 0) {
                    markUnshieldProofGenerating(txId)
                  } else if (progress.proofProgress !== undefined) {
                    updateUnshieldProofProgress(txId, progress.proofProgress)
                  }
                  break
                case 'signing':
                  markUnshieldProofComplete(txId)
                  markUnshieldPending(txId)
                  break
              }
            }

            // Update toast based on stage
            switch (progress.stage) {
              case 'preparing':
                updateToast(toastId, {
                  title: 'Preparing',
                  description: progress.message,
                })
                break
              case 'init-prover':
                updateToast(toastId, {
                  title: 'Initializing prover',
                  description: 'Loading proving system...',
                })
                break
              case 'generating-proof':
                updateToast(toastId, {
                  title: 'Generating proof',
                  description: progress.message,
                })
                break
              case 'signing':
                updateToast(toastId, {
                  title: 'Sign transaction',
                  description: 'Please sign the transaction',
                })
                break
              case 'confirming':
                updateToast(toastId, {
                  title: 'Confirming',
                  description: 'Waiting for confirmation...',
                })
                break
              case 'success':
                dismissToast(toastId)
                notify({
                  title: `${operationType} successful!`,
                  description: `Sent ${amount} USDC`,
                  level: 'success',
                })
                break
            }
          },
        )

        // Update tracker with tx hash and mark complete
        if (isPrivateTransfer) {
          if (details.txHash) {
            markTransferSubmitted(txId, details.txHash)
          }
          markTransferCompleted(txId)
        } else {
          if (details.txHash) {
            markUnshieldSubmitted(txId, details.txHash)
          }
          markUnshieldCompleted(txId)
        }

        setLastTransaction(details)
        setStage('success')
        setStageMessage(`${operationType} complete!`)

        // Refresh shielded balance after successful send
        console.log('[send-tx] Triggering balance refresh...')
        refreshBalance()

        onSuccess?.(details)
      } catch (err) {
        console.error('[send-tx] Send failed:', err)

        const sanitized = sanitizeError(err)

        // Handle user rejection
        if (sanitized.category === 'user_rejection') {
          // Mark as failed in tracker
          if (isPrivateTransfer) {
            markTransferFailed(txId, new Error('User cancelled'))
          } else {
            markUnshieldFailed(txId, new Error('User cancelled'))
          }
          dismissToast(toastId)
          notify({
            title: 'Transaction cancelled',
            level: 'info',
          })
          setIsSubmitting(false)
          setStage(null)
          setStageMessage(null)
          setProofProgress(0)
          return
        }

        // Mark as failed in tracker
        const errorObj = err instanceof Error ? err : new Error(sanitized.message)
        if (isPrivateTransfer) {
          markTransferFailed(txId, errorObj)
        } else {
          markUnshieldFailed(txId, errorObj)
        }

        setError(sanitized.message)
        setStage('error')
        setStageMessage(sanitized.message)

        dismissToast(toastId)
        notify({
          title: `${operationType} failed`,
          description: sanitized.message,
          level: 'error',
        })

        onError?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsSubmitting(false)
      }
    },
    [
      walletState.metaMask.account,
      walletId,
      encryptionKey,
      shieldedBalance,
      notify,
      updateToast,
      dismissToast,
      refreshBalance,
    ],
  )

  return {
    submitSend,
    isSubmitting,
    stage,
    stageMessage,
    proofProgress,
    error,
    lastTransaction,
    currentTxId,
  }
}

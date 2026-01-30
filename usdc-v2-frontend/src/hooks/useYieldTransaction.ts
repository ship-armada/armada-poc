/**
 * Yield Transaction Hook
 *
 * Handles lend and redeem operations with the ArmadaYieldAdapter.
 * Manages UI state, transaction progress, and error handling.
 */

import { useState, useCallback } from 'react'
import { ethers } from 'ethers'
import { useShieldedWallet } from './useShieldedWallet'
import { useToast } from './useToast'
import {
  executeLendTransaction,
  executeRedeemTransaction,
  type YieldProgress,
  type YieldStage,
  type YieldTransactionDetails,
} from '@/services/yield'
import { sanitizeError } from '@/utils/errorSanitizer'

// ============ Types ============

export interface UseLendParams {
  /** Amount in human readable format (e.g., "100.50") */
  amount: string
  /** Called on successful lend */
  onSuccess?: (details: YieldTransactionDetails) => void
  /** Called on error */
  onError?: (error: Error) => void
}

export interface UseRedeemParams {
  /** Shares in human readable format (e.g., "100.50") */
  shares: string
  /** Called on successful redeem */
  onSuccess?: (details: YieldTransactionDetails) => void
  /** Called on error */
  onError?: (error: Error) => void
}

export interface UseYieldTransactionReturn {
  /** Submit a lend transaction (USDC → ayUSDC) */
  submitLend: (params: UseLendParams) => Promise<void>
  /** Submit a redeem transaction (ayUSDC → USDC) */
  submitRedeem: (params: UseRedeemParams) => Promise<void>
  /** Whether a transaction is in progress */
  isSubmitting: boolean
  /** Current transaction stage */
  stage: YieldStage | null
  /** Current stage message */
  stageMessage: string | null
  /** Last error if any */
  error: string | null
  /** Last successful transaction details */
  lastTransaction: YieldTransactionDetails | null
}

// ============ Hook ============

export function useYieldTransaction(): UseYieldTransactionReturn {
  const { refreshBalance } = useShieldedWallet()
  const { notify, updateToast, dismissToast } = useToast()

  // State
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [stage, setStage] = useState<YieldStage | null>(null)
  const [stageMessage, setStageMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastTransaction, setLastTransaction] =
    useState<YieldTransactionDetails | null>(null)

  // Get signer from MetaMask
  const getSigner = useCallback(async () => {
    if (!window.ethereum) {
      throw new Error('MetaMask not available')
    }
    const provider = new ethers.BrowserProvider(window.ethereum)
    return provider.getSigner()
  }, [])

  // Submit lend transaction
  const submitLend = useCallback(
    async (params: UseLendParams) => {
      const { amount, onSuccess, onError } = params

      setIsSubmitting(true)
      setError(null)
      setStage(null)
      setStageMessage(null)

      const toastId = notify({
        title: 'Preparing lend...',
        level: 'loading',
      })

      try {
        const signer = await getSigner()

        const details = await executeLendTransaction(
          { amount },
          signer,
          (progress: YieldProgress) => {
            setStage(progress.stage)
            setStageMessage(progress.message)

            // Update toast based on stage
            switch (progress.stage) {
              case 'preparing':
                updateToast(toastId, {
                  title: 'Preparing',
                  description: progress.message,
                })
                break
              case 'approving':
                updateToast(toastId, {
                  title: 'Approving USDC',
                  description: 'Please sign the approval...',
                })
                break
              case 'signing':
                updateToast(toastId, {
                  title: 'Sign transaction',
                  description: 'Please sign the lend transaction',
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
                  title: 'Lend successful!',
                  description: `Deposited ${amount} USDC to earn yield`,
                  level: 'success',
                })
                break
            }
          },
        )

        setLastTransaction(details)
        setStage('success')
        setStageMessage('Lend complete!')

        // Refresh balance after successful lend
        console.log('[yield-tx] Triggering balance refresh...')
        refreshBalance()

        onSuccess?.(details)
      } catch (err) {
        console.error('[yield-tx] Lend failed:', err)

        const sanitized = sanitizeError(err)

        // Handle user rejection
        if (sanitized.category === 'user_rejection') {
          dismissToast(toastId)
          notify({
            title: 'Transaction cancelled',
            level: 'info',
          })
          setIsSubmitting(false)
          setStage(null)
          setStageMessage(null)
          return
        }

        setError(sanitized.message)
        setStage('error')
        setStageMessage(sanitized.message)

        dismissToast(toastId)
        notify({
          title: 'Lend failed',
          description: sanitized.message,
          level: 'error',
        })

        onError?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsSubmitting(false)
      }
    },
    [getSigner, notify, updateToast, dismissToast, refreshBalance],
  )

  // Submit redeem transaction
  const submitRedeem = useCallback(
    async (params: UseRedeemParams) => {
      const { shares, onSuccess, onError } = params

      setIsSubmitting(true)
      setError(null)
      setStage(null)
      setStageMessage(null)

      const toastId = notify({
        title: 'Preparing redeem...',
        level: 'loading',
      })

      try {
        const signer = await getSigner()

        const details = await executeRedeemTransaction(
          { shares },
          signer,
          (progress: YieldProgress) => {
            setStage(progress.stage)
            setStageMessage(progress.message)

            // Update toast based on stage
            switch (progress.stage) {
              case 'preparing':
                updateToast(toastId, {
                  title: 'Preparing',
                  description: progress.message,
                })
                break
              case 'approving':
                updateToast(toastId, {
                  title: 'Approving ayUSDC',
                  description: 'Please sign the approval...',
                })
                break
              case 'signing':
                updateToast(toastId, {
                  title: 'Sign transaction',
                  description: 'Please sign the redeem transaction',
                })
                break
              case 'confirming':
                updateToast(toastId, {
                  title: 'Confirming',
                  description: 'Waiting for confirmation...',
                })
                break
              case 'success':
                // Note: details not available yet in callback, handle success notification after await
                dismissToast(toastId)
                break
            }
          },
        )

        setLastTransaction(details)
        setStage('success')
        setStageMessage('Redeem complete!')

        // Show success notification (after await so details is available)
        notify({
          title: 'Redeem successful!',
          description: `Redeemed ${details.usdcAmount} USDC from yield position`,
          level: 'success',
        })

        // Refresh balance after successful redeem
        console.log('[yield-tx] Triggering balance refresh...')
        refreshBalance()

        onSuccess?.(details)
      } catch (err) {
        console.error('[yield-tx] Redeem failed:', err)

        const sanitized = sanitizeError(err)

        // Handle user rejection
        if (sanitized.category === 'user_rejection') {
          dismissToast(toastId)
          notify({
            title: 'Transaction cancelled',
            level: 'info',
          })
          setIsSubmitting(false)
          setStage(null)
          setStageMessage(null)
          return
        }

        setError(sanitized.message)
        setStage('error')
        setStageMessage(sanitized.message)

        dismissToast(toastId)
        notify({
          title: 'Redeem failed',
          description: sanitized.message,
          level: 'error',
        })

        onError?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsSubmitting(false)
      }
    },
    [getSigner, notify, updateToast, dismissToast, refreshBalance],
  )

  return {
    submitLend,
    submitRedeem,
    isSubmitting,
    stage,
    stageMessage,
    error,
    lastTransaction,
  }
}

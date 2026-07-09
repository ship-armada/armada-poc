/**
 * Shielded Yield Transaction Hook
 *
 * Handles trustless shielded lend and redeem operations:
 * - Shielded USDC -> Shielded ayUSDC (lend)
 * - Shielded ayUSDC -> Shielded USDC (redeem)
 *
 * Trust model (see docs/RELAYER_SPEC.md): ArmadaYieldAdapter cannot deviate from
 * the proof; adaptParams binds re-shield destination. Relayer pays gas, may charge
 * fee, but cannot steal funds.
 */

import { useState, useCallback } from 'react'
import { useShieldedWallet } from './useShieldedWallet'
import { useToast } from './useToast'
import {
  executeShieldedLend,
  executeShieldedRedeem,
  validateShieldedLendParams,
  validateShieldedRedeemParams,
  type ShieldedYieldProgress,
  type ShieldedYieldStage,
  type ShieldedYieldResult,
} from '@/services/yield'
// Shielded yield uses ArmadaYieldAdapter.lendAndShield/redeemAndShield
import { sanitizeError } from '@/utils/errorSanitizer'
import { parseUSDC } from '@/lib/sdk'

// ============ Types ============

export interface UseShieldedLendParams {
  /** Amount in human readable format (e.g., "100.50") */
  amount: string
  /** Called on successful lend */
  onSuccess?: (result: ShieldedYieldResult) => void
  /** Called on error */
  onError?: (error: Error) => void
}

export interface UseShieldedRedeemParams {
  /** Shares in human readable format (e.g., "100.50") */
  shares: string
  /** Called on successful redeem */
  onSuccess?: (result: ShieldedYieldResult) => void
  /** Called on error */
  onError?: (error: Error) => void
}

export interface UseShieldedYieldTransactionReturn {
  /** Submit a shielded lend transaction (USDC -> ayUSDC) */
  submitShieldedLend: (params: UseShieldedLendParams) => Promise<void>
  /** Submit a shielded redeem transaction (ayUSDC -> USDC) */
  submitShieldedRedeem: (params: UseShieldedRedeemParams) => Promise<void>
  /** Whether a transaction is in progress */
  isSubmitting: boolean
  /** Current transaction stage */
  stage: ShieldedYieldStage | null
  /** Current stage message */
  stageMessage: string | null
  /** Proof generation progress (0-1) */
  proofProgress: number | null
  /** Last error if any */
  error: string | null
  /** Last successful transaction result */
  lastResult: ShieldedYieldResult | null
}

// ============ Hook ============

export function useShieldedYieldTransaction(): UseShieldedYieldTransactionReturn {
  const {
    railgunAddress,
    walletId,
    encryptionKey,
    usdcBalance,
    yieldSharesBalance,
    refreshBalance,
  } = useShieldedWallet()
  const { notify, updateToast, dismissToast } = useToast()

  // State
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [stage, setStage] = useState<ShieldedYieldStage | null>(null)
  const [stageMessage, setStageMessage] = useState<string | null>(null)
  const [proofProgress, setProofProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<ShieldedYieldResult | null>(null)

  // Note: Shield private key is no longer needed with cross-contract calls approach
  // Proof module generates trustless lend/redeem via ArmadaYieldAdapter

  // Submit shielded lend transaction
  const submitShieldedLend = useCallback(
    async (params: UseShieldedLendParams) => {
      const { amount, onSuccess, onError } = params

      // Validate wallet state
      if (!railgunAddress) {
        const err = new Error('Shielded wallet not unlocked')
        setError(err.message)
        onError?.(err)
        return
      }

      if (!walletId || !encryptionKey) {
        const err = new Error('Wallet credentials not available')
        setError(err.message)
        onError?.(err)
        return
      }

      // Validate amount
      const amountRaw = parseUSDC(amount)
      if (amountRaw > usdcBalance) {
        const err = new Error('Insufficient shielded USDC balance')
        setError(err.message)
        onError?.(err)
        return
      }

      setIsSubmitting(true)
      setError(null)
      setStage(null)
      setStageMessage(null)
      setProofProgress(null)

      const toastId = notify({
        title: 'Preparing shielded lend...',
        level: 'loading',
      })

      try {
        // Validate params
        updateToast(toastId, {
          title: 'Validating',
          description: 'Checking parameters...',
        })

        const validation = await validateShieldedLendParams(
          { amount, railgunAddress },
          usdcBalance,
        )
        if (!validation.valid) {
          throw new Error(validation.error || 'Invalid parameters')
        }

        // Execute shielded lend using cross-contract calls
        const result = await executeShieldedLend(
          { amount, railgunAddress },
          walletId,
          encryptionKey,
          (progress: ShieldedYieldProgress) => {
            setStage(progress.stage)
            setStageMessage(progress.message)
            if (progress.proofProgress !== undefined) {
              setProofProgress(progress.proofProgress)
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
                  description: 'Loading proving keys...',
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
                // Don't handle here - result not yet available
                // Success notification is shown after executeShieldedLend returns
                break
            }
          },
        )

        // Show success notification now that we have the result
        dismissToast(toastId)
        notify({
          title: 'Shielded lend complete!',
          description: `Deposited ${amount} USDC -> ${result.outputAmount} ayUSDC`,
          level: 'success',
        })

        setLastResult(result)
        setStage('success')
        setStageMessage('Shielded lend complete!')

        // Refresh balance after successful lend
        console.log('[shielded-yield-tx] Triggering balance refresh...')
        refreshBalance()

        onSuccess?.(result)
      } catch (err) {
        console.error('[shielded-yield-tx] Shielded lend failed:', err)

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
          setProofProgress(null)
          return
        }

        setError(sanitized.message)
        setStage('error')
        setStageMessage(sanitized.message)

        dismissToast(toastId)
        notify({
          title: 'Shielded lend failed',
          description: sanitized.message,
          level: 'error',
        })

        onError?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsSubmitting(false)
      }
    },
    [
      railgunAddress,
      walletId,
      encryptionKey,
      usdcBalance,
      notify,
      updateToast,
      dismissToast,
      refreshBalance,
    ],
  )

  // Submit shielded redeem transaction
  const submitShieldedRedeem = useCallback(
    async (params: UseShieldedRedeemParams) => {
      const { shares, onSuccess, onError } = params

      // Validate wallet state
      if (!railgunAddress) {
        const err = new Error('Shielded wallet not unlocked')
        setError(err.message)
        onError?.(err)
        return
      }

      if (!walletId || !encryptionKey) {
        const err = new Error('Wallet credentials not available')
        setError(err.message)
        onError?.(err)
        return
      }

      // Validate shares
      const sharesRaw = parseUSDC(shares)
      if (sharesRaw > yieldSharesBalance) {
        const err = new Error('Insufficient shielded ayUSDC balance')
        setError(err.message)
        onError?.(err)
        return
      }

      setIsSubmitting(true)
      setError(null)
      setStage(null)
      setStageMessage(null)
      setProofProgress(null)

      const toastId = notify({
        title: 'Preparing shielded redeem...',
        level: 'loading',
      })

      try {
        // Validate params
        updateToast(toastId, {
          title: 'Validating',
          description: 'Checking parameters...',
        })

        const validation = await validateShieldedRedeemParams(
          { shares, railgunAddress },
          yieldSharesBalance,
        )
        if (!validation.valid) {
          throw new Error(validation.error || 'Invalid parameters')
        }

        // Execute shielded redeem using cross-contract calls
        const result = await executeShieldedRedeem(
          { shares, railgunAddress },
          walletId,
          encryptionKey,
          (progress: ShieldedYieldProgress) => {
            setStage(progress.stage)
            setStageMessage(progress.message)
            if (progress.proofProgress !== undefined) {
              setProofProgress(progress.proofProgress)
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
                  description: 'Loading proving keys...',
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
                // Don't handle here - result not yet available
                // Success notification is shown after executeShieldedRedeem returns
                break
            }
          },
        )

        // Show success notification now that we have the result
        dismissToast(toastId)
        notify({
          title: 'Shielded redeem complete!',
          description: `Redeemed ${shares} ayUSDC -> ${result.outputAmount} USDC`,
          level: 'success',
        })

        setLastResult(result)
        setStage('success')
        setStageMessage('Shielded redeem complete!')

        // Refresh balance after successful redeem
        console.log('[shielded-yield-tx] Triggering balance refresh...')
        refreshBalance()

        onSuccess?.(result)
      } catch (err) {
        console.error('[shielded-yield-tx] Shielded redeem failed:', err)

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
          setProofProgress(null)
          return
        }

        setError(sanitized.message)
        setStage('error')
        setStageMessage(sanitized.message)

        dismissToast(toastId)
        notify({
          title: 'Shielded redeem failed',
          description: sanitized.message,
          level: 'error',
        })

        onError?.(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsSubmitting(false)
      }
    },
    [
      railgunAddress,
      walletId,
      encryptionKey,
      yieldSharesBalance,
      notify,
      updateToast,
      dismissToast,
      refreshBalance,
    ],
  )

  return {
    submitShieldedLend,
    submitShieldedRedeem,
    isSubmitting,
    stage,
    stageMessage,
    proofProgress,
    error,
    lastResult,
  }
}

/**
 * Shield Transaction Hook
 *
 * Handles the complete shield transaction flow including:
 * - Deriving shield private key from signature
 * - Building and executing the shield transaction
 * - Updating UI state and showing toast notifications
 * - Tracking transaction progress in storage
 */

import { useState, useCallback, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { walletAtom } from '@/atoms/walletAtom'
import { useShieldedWallet } from './useShieldedWallet'
import { useToast } from './useToast'
import {
  executeShieldTransaction,
  validateShieldParams,
  type ShieldTransactionParams,
  type ShieldTransactionDetails,
  type ShieldProgress,
} from '@/services/shield'
import {
  SHIELD_SIGNATURE_MESSAGE,
  deriveShieldPrivateKey,
} from '@/lib/railgun/shield'
import { sanitizeError } from '@/utils/errorSanitizer'
import { parseUSDC } from '@/lib/sdk'
import { isHubChain } from '@/services/send/sendContractService'
import {
  initShieldTransaction,
  markApprovalPending,
  markApprovalConfirmed,
  markShieldPending,
  markShieldSubmitted,
  markShieldCompleted,
  markShieldFailed,
  // CCTP stages for cross-chain shield
  markCCTPBurnPending,
  markCCTPBurnSubmitted,
  markShieldCCTPMintConfirmed,
  type ShieldTxParams,
  type ChainScope,
} from '@/services/tx'

// ============ Types ============

export interface UseShieldTransactionParams {
  /** Amount in human readable format (e.g., "100.50") */
  amount: string
  /** Chain key (currently only "hub" supported) */
  chainKey: string
  /** Called on successful shield */
  onSuccess?: (details: ShieldTransactionDetails) => void
  /** Called on error */
  onError?: (error: Error) => void
}

export interface UseShieldTransactionReturn {
  /** Submit a shield transaction */
  submitShield: (params: UseShieldTransactionParams) => Promise<void>
  /** Whether a shield transaction is in progress */
  isSubmitting: boolean
  /** Current transaction stage */
  stage: ShieldProgress['stage'] | null
  /** Current stage message */
  stageMessage: string | null
  /** Last error if any */
  error: string | null
  /** Last successful transaction details */
  lastTransaction: ShieldTransactionDetails | null
  /** Current tracked transaction ID */
  currentTxId: string | null
}

// ============ Hook ============

export function useShieldTransaction(): UseShieldTransactionReturn {
  const walletState = useAtomValue(walletAtom)
  const { railgunAddress, refreshBalance } = useShieldedWallet()
  const { notify, updateToast, dismissToast } = useToast()

  // State
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [stage, setStage] = useState<ShieldProgress['stage'] | null>(null)
  const [stageMessage, setStageMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastTransaction, setLastTransaction] =
    useState<ShieldTransactionDetails | null>(null)
  const [currentTxId, setCurrentTxId] = useState<string | null>(null)

  // Cache shield private key to avoid re-signing
  const shieldPrivateKeyRef = useRef<string | null>(null)

  // Get or derive shield private key
  const getShieldPrivateKey = useCallback(async (): Promise<string> => {
    // Return cached key if available
    if (shieldPrivateKeyRef.current) {
      return shieldPrivateKeyRef.current
    }

    // Request signature from MetaMask
    if (!window.ethereum) {
      throw new Error('MetaMask not available')
    }

    const address = walletState.metaMask.account
    if (!address) {
      throw new Error('No wallet connected')
    }

    console.log('[shield-tx] Requesting shield signature...')
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [SHIELD_SIGNATURE_MESSAGE, address],
    })

    if (typeof signature !== 'string') {
      throw new Error('Invalid signature')
    }

    // Derive and cache the shield private key
    const shieldPrivateKey = deriveShieldPrivateKey(signature)
    shieldPrivateKeyRef.current = shieldPrivateKey

    return shieldPrivateKey
  }, [walletState.metaMask.account])

  // Submit shield transaction
  const submitShield = useCallback(
    async (params: UseShieldTransactionParams) => {
      const { amount, chainKey, onSuccess, onError } = params
      const evmAddress = walletState.metaMask.account

      if (!evmAddress) {
        const err = new Error('No wallet connected')
        setError(err.message)
        onError?.(err)
        return
      }

      if (!railgunAddress) {
        const err = new Error('Shielded wallet not unlocked')
        setError(err.message)
        onError?.(err)
        return
      }

      setIsSubmitting(true)
      setError(null)
      setStage(null)
      setStageMessage(null)
      setCurrentTxId(null)

      // Determine if cross-chain shield
      const isCrossChain = !isHubChain(chainKey)

      // Initialize transaction tracking
      const amountRaw = parseUSDC(amount)
      const txParams: ShieldTxParams = {
        amount,
        amountRaw: amountRaw.toString(),
        tokenSymbol: 'USDC',
        sourceChain: chainKey as ChainScope,
        publicAddress: evmAddress,
        railgunAddress,
        isCrossChain,
      }
      const trackedTx = initShieldTransaction(txParams)
      const txId = trackedTx.id
      setCurrentTxId(txId)

      // Show initial toast
      const toastId = notify({
        title: 'Preparing shield...',
        level: 'loading',
      })

      try {
        // Get shield private key (may prompt for signature)
        setStage('preparing')
        setStageMessage('Preparing shield...')
        updateToast(toastId, {
          title: 'Sign message',
          description: 'Please sign to derive shield key',
        })

        const shieldPrivateKey = await getShieldPrivateKey()

        // Build transaction params
        const shieldParams: ShieldTransactionParams = {
          amount,
          railgunAddress,
          evmAddress,
          chainKey,
          shieldPrivateKey,
        }

        // Validate params
        const validation = await validateShieldParams(shieldParams)
        if (!validation.valid) {
          throw new Error(validation.error || 'Invalid shield parameters')
        }

        // Execute the shield transaction
        const details = await executeShieldTransaction(
          shieldParams,
          (progress) => {
            setStage(progress.stage)
            setStageMessage(progress.message)

            // Update transaction tracker based on stage
            // Use different functions for cross-chain vs direct shield
            switch (progress.stage) {
              case 'approving':
                markApprovalPending(txId)
                updateToast(toastId, {
                  title: 'Approving USDC',
                  description: 'Please approve the transaction',
                })
                break
              case 'building':
                markApprovalConfirmed(txId)
                updateToast(toastId, {
                  title: 'Building transaction',
                  description: 'Creating shield request...',
                })
                break
              case 'signing':
                // Use CCTP burn pending for cross-chain, shield pending for direct
                if (isCrossChain) {
                  markCCTPBurnPending(txId)
                } else {
                  markShieldPending(txId)
                }
                updateToast(toastId, {
                  title: 'Sign transaction',
                  description: isCrossChain
                    ? 'Please sign the cross-chain shield transaction'
                    : 'Please sign the shield transaction',
                })
                break
              case 'submitting':
                updateToast(toastId, {
                  title: 'Submitting',
                  description: 'Transaction submitted...',
                })
                break
              case 'success':
                dismissToast(toastId)
                notify({
                  title: isCrossChain ? 'Cross-chain shield initiated!' : 'Shield successful!',
                  description: isCrossChain
                    ? `Shielding ${amount} USDC via CCTP...`
                    : `Shielded ${amount} USDC`,
                  level: 'success',
                })
                break
            }
          },
        )

        // Update tracker with tx hash and mark complete
        if (details.txHash) {
          if (isCrossChain) {
            // For cross-chain, mark CCTP burn submitted
            // Note: The full CCTP flow (attestation, relay) is handled by backend/polling
            markCCTPBurnSubmitted(txId, details.txHash)
            // For now, we mark as complete since the CCTP relay happens asynchronously
            // TODO: Implement full CCTP tracking with attestation polling
            markShieldCCTPMintConfirmed(txId, details.txHash, 0)
          } else {
            markShieldSubmitted(txId, details.txHash)
          }
        }
        markShieldCompleted(txId)

        setLastTransaction(details)
        setStage('success')
        setStageMessage('Shield complete!')

        // Refresh shielded balance after successful shield
        console.log('[shield-tx] Triggering balance refresh...')
        refreshBalance()

        onSuccess?.(details)
      } catch (err) {
        console.error('[shield-tx] Shield failed:', err)

        const sanitized = sanitizeError(err)

        // Handle user rejection
        if (sanitized.category === 'user_rejection') {
          // Mark as failed in tracker
          markShieldFailed(txId, new Error('User cancelled'))
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

        // Mark as failed in tracker
        markShieldFailed(txId, err instanceof Error ? err : new Error(sanitized.message))

        setError(sanitized.message)
        setStage('error')
        setStageMessage(sanitized.message)

        dismissToast(toastId)
        notify({
          title: 'Shield failed',
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
      railgunAddress,
      getShieldPrivateKey,
      notify,
      updateToast,
      dismissToast,
      refreshBalance,
    ],
  )

  return {
    submitShield,
    isSubmitting,
    stage,
    stageMessage,
    error,
    lastTransaction,
    currentTxId,
  }
}

// ABOUTME: Transaction submission state machine wired to shared sonner toasts.
// ABOUTME: Each execute() call drives pending → submitted → confirmed|failed toasts + lastTxAtom.

import { useState, useCallback } from 'react'
import type { TransactionResponse, TransactionReceipt, Signer } from 'ethers'
import { useTxToast } from '@armada/crowdfund-shared'
import { mapRevertToMessage } from '@/lib/revertMessages'

export type TxStatus = 'idle' | 'pending' | 'submitted' | 'confirmed' | 'error'

export interface TxState {
  status: TxStatus
  txHash: string | null
  receipt: TransactionReceipt | null
  error: string | null
}

export interface UseTransactionFlowOptions {
  /** Explorer base URL (e.g. `https://sepolia.etherscan.io`). Propagated to toast "View" actions and the LastTxChip. */
  explorerUrl?: string
}

export interface UseTransactionFlowResult {
  state: TxState
  /**
   * Submit a transaction. `label` is the short human-readable title shown in the
   * toast and LastTxChip (e.g. "Commit 500 USDC at hop-0"). `options.successMessage`
   * overrides the default "<label> confirmed" title on success.
   */
  execute: (
    label: string,
    fn: (signer: Signer) => Promise<TransactionResponse>,
    options?: { successMessage?: string },
  ) => Promise<boolean>
  reset: () => void
}

/**
 * Hook for managing transaction submission lifecycle.
 * Provides a consistent flow: idle → pending → submitted → confirmed/error.
 * Each transition also fires a sonner toast + updates the shared lastTxAtom.
 */
export function useTransactionFlow(
  signer: Signer | null,
  options: UseTransactionFlowOptions = {},
): UseTransactionFlowResult {
  const toast = useTxToast({ explorerUrl: options.explorerUrl })
  const [state, setState] = useState<TxState>({
    status: 'idle',
    txHash: null,
    receipt: null,
    error: null,
  })

  const reset = useCallback(() => {
    setState({ status: 'idle', txHash: null, receipt: null, error: null })
  }, [])

  const execute = useCallback(
    async (
      label: string,
      fn: (signer: Signer) => Promise<TransactionResponse>,
      execOptions?: { successMessage?: string },
    ): Promise<boolean> => {
      if (!signer) {
        setState({
          status: 'error',
          txHash: null,
          receipt: null,
          error: 'Wallet not connected',
        })
        return false
      }

      setState({ status: 'pending', txHash: null, receipt: null, error: null })
      const handle = toast.notifyTxPending(label)

      let txHash: string | null = null
      try {
        const tx = await fn(signer)
        txHash = tx.hash
        setState({
          status: 'submitted',
          txHash,
          receipt: null,
          error: null,
        })
        toast.notifyTxSubmitted(handle, txHash)

        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          const msg = 'Transaction reverted'
          setState({
            status: 'error',
            txHash,
            receipt,
            error: msg,
          })
          toast.notifyTxFailed(handle, msg)
          return false
        }

        setState({
          status: 'confirmed',
          txHash,
          receipt,
          error: null,
        })
        toast.notifyTxConfirmed(handle, execOptions?.successMessage)
        return true
      } catch (err) {
        const msg = mapRevertToMessage(err)
        setState({
          status: 'error',
          txHash,
          receipt: null,
          error: msg,
        })
        toast.notifyTxFailed(handle, msg)
        return false
      }
    },
    [signer, toast],
  )

  return { state, execute, reset }
}

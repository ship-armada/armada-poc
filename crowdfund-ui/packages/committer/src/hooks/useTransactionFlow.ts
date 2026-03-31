// ABOUTME: Transaction submission state machine.
// ABOUTME: Handles pending → submitted → confirmed → error flow for contract writes.

import { useState, useCallback } from 'react'
import type { TransactionResponse, TransactionReceipt, Signer } from 'ethers'
import { mapRevertToMessage } from '@/lib/revertMessages'

export type TxStatus = 'idle' | 'pending' | 'submitted' | 'confirmed' | 'error'

export interface TxState {
  status: TxStatus
  txHash: string | null
  receipt: TransactionReceipt | null
  error: string | null
}

export interface UseTransactionFlowResult {
  state: TxState
  execute: (fn: (signer: Signer) => Promise<TransactionResponse>) => Promise<boolean>
  reset: () => void
}

/**
 * Hook for managing transaction submission lifecycle.
 * Provides a consistent flow: idle → pending → submitted → confirmed/error.
 */
export function useTransactionFlow(signer: Signer | null): UseTransactionFlowResult {
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
      fn: (signer: Signer) => Promise<TransactionResponse>,
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

      try {
        const tx = await fn(signer)
        setState({
          status: 'submitted',
          txHash: tx.hash,
          receipt: null,
          error: null,
        })

        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          setState({
            status: 'error',
            txHash: tx.hash,
            receipt,
            error: 'Transaction reverted',
          })
          return false
        }

        setState({
          status: 'confirmed',
          txHash: tx.hash,
          receipt,
          error: null,
        })
        return true
      } catch (err) {
        setState({
          status: 'error',
          txHash: state.txHash,
          receipt: null,
          error: mapRevertToMessage(err),
        })
        return false
      }
    },
    [signer, state.txHash],
  )

  return { state, execute, reset }
}

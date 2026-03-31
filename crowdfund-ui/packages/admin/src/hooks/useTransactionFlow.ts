// ABOUTME: Transaction submission state machine for admin operations.
// ABOUTME: Handles pending → submitted → confirmed → error flow with admin-specific error messages.

import { useState, useCallback } from 'react'
import type { TransactionResponse, TransactionReceipt, Signer } from 'ethers'

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

/** Map common revert reasons to human-readable messages */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  if (msg.includes('user rejected')) return 'Transaction rejected by user'
  if (msg.includes('insufficient funds')) return 'Insufficient funds for gas'
  if (msg.includes('not active')) return 'Crowdfund is not in the active phase'
  if (msg.includes('not launch team')) return 'Only the launch team can perform this action'
  if (msg.includes('not security council')) return 'Only the security council can perform this action'
  if (msg.includes('outside week-1 window')) return 'Launch team invite window has closed'
  if (msg.includes('max seeds reached')) return 'Maximum seed count (150) has been reached'
  if (msg.includes('already finalized')) return 'Crowdfund has already been finalized'
  if (msg.includes('already canceled')) return 'Crowdfund has already been canceled'
  if (msg.includes('window not ended')) return 'Commitment window has not ended yet'
  if (msg.includes('nothing to sweep')) return 'No unallocated ARM to sweep'
  if (msg.includes('ARM not loaded')) return 'ARM tokens have not been loaded yet'
  if (msg.includes('below minimum')) return 'Amount is below the minimum commitment'
  if (msg.includes('not whitelisted')) return 'Address is not invited at this hop level'
  if (msg.includes('no invites remaining')) return 'No invite slots remaining at this hop'
  if (msg.includes('already claimed')) return 'Already claimed'
  if (msg.includes('nonce')) return 'Invite nonce is invalid or already used'

  if (msg.length > 200) return msg.slice(0, 200) + '...'
  return msg
}

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

        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          setState({
            status: 'error',
            txHash,
            receipt,
            error: 'Transaction reverted',
          })
          return false
        }

        setState({
          status: 'confirmed',
          txHash,
          receipt,
          error: null,
        })
        return true
      } catch (err) {
        setState({
          status: 'error',
          txHash,
          receipt: null,
          error: friendlyError(err),
        })
        return false
      }
    },
    [signer],
  )

  return { state, execute, reset }
}

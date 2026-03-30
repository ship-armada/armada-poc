// ABOUTME: Transaction submission state machine.
// ABOUTME: Handles pending → submitted → confirmed → error flow for contract writes.

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
  if (msg.includes('not active window')) return 'Commitment window is not open'
  if (msg.includes('ARM not loaded')) return 'ARM tokens have not been loaded yet'
  if (msg.includes('below minimum')) return 'Amount is below the minimum commitment'
  if (msg.includes('not whitelisted')) return 'Address is not invited at this hop level'
  if (msg.includes('no invites remaining')) return 'No invite slots remaining at this hop'
  if (msg.includes('already claimed')) return 'Already claimed'
  if (msg.includes('deadline passed')) return 'The commitment deadline has passed'
  if (msg.includes('cancelled')) return 'The crowdfund has been cancelled'
  if (msg.includes('already finalized')) return 'The crowdfund has already been finalized'
  if (msg.includes('claim expired')) return 'The claim deadline has passed'
  if (msg.includes('invalid signature')) return 'Invalid invite link signature'
  if (msg.includes('nonce consumed')) return 'This invite link has already been used'
  if (msg.includes('nonce revoked')) return 'This invite link has been revoked'
  if (msg.includes('nonce')) return 'Invite nonce is invalid or already used'

  // Truncate long error messages
  if (msg.length > 200) return msg.slice(0, 200) + '...'
  return msg
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
          error: friendlyError(err),
        })
        return false
      }
    },
    [signer, state.txHash],
  )

  return { state, execute, reset }
}

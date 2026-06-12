// ABOUTME: Single-step send/wait engine — submits a tx, waits for its receipt, classifies the outcome.
// ABOUTME: Shared by the multi-step pipeline store and ClaimFlow so both inherit the same tx handling.

import type { TransactionResponse } from 'ethers'
import type { ReceiptLogLike } from '@armada/crowdfund-shared'
import { mapRevertToMessage } from '@/lib/revertMessages'
import { TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE, isTxTimeoutError, isUserRejection } from '@/lib/txWait'

export type TxOutcome = 'success' | 'reverted' | 'timeout' | 'rejected' | 'error'

export interface TxSendResult {
  outcome: TxOutcome
  /** Present once the tx is broadcast (the wallet returned a hash). */
  hash?: string
  /** Receipt logs on a confirmed tx — fed to the event store for fast graph updates. */
  logs?: readonly ReceiptLogLike[]
  /** User-facing summary for non-success outcomes. */
  errorMessage?: string
  /** Full detail for a "show details" toggle (e.g. the tx hash on timeout). */
  errorDetails?: string
}

/**
 * Submit a transaction and wait (bounded by {@link TX_WAIT_TIMEOUT_MS}) for its
 * receipt, returning a classified outcome rather than throwing. The transaction
 * is never cancelled or auto-resubmitted — a timeout means "still pending", not
 * "failed".
 *
 * @param send Issues the tx (pops the wallet prompt) and resolves to its response.
 * @param onSubmitted Called with the tx hash the moment it is broadcast — used
 *   for two-phase row labels and pending-tx persistence.
 */
export async function sendAndWaitTx(
  send: () => Promise<TransactionResponse>,
  onSubmitted?: (hash: string) => void,
): Promise<TxSendResult> {
  let hash: string | undefined
  try {
    const tx = await send()
    hash = tx.hash
    onSubmitted?.(hash)
    const receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS)
    if (!receipt || receipt.status === 0) {
      return { outcome: 'reverted', hash, errorMessage: 'Transaction reverted' }
    }
    // ethers v6 receipt.logs is structurally compatible with ReceiptLogLike
    // (the `index` vs `logIndex` field name differs); cast through unknown.
    return { outcome: 'success', hash, logs: receipt.logs as unknown as readonly ReceiptLogLike[] }
  } catch (err) {
    if (isTxTimeoutError(err)) {
      // The tx may still confirm — surface it as pending, never as success or
      // failure, and never auto-resubmit.
      return {
        outcome: 'timeout',
        hash,
        errorMessage: TX_PENDING_MESSAGE,
        errorDetails: hash ? `Transaction hash: ${hash}` : undefined,
      }
    }
    if (isUserRejection(err)) {
      return { outcome: 'rejected', hash, errorMessage: 'Cancelled in wallet' }
    }
    return {
      outcome: 'error',
      hash,
      errorMessage: mapRevertToMessage(err),
      errorDetails: err instanceof Error ? err.message : String(err),
    }
  }
}

// ABOUTME: Single-step send/wait engine — submits a tx, waits for its receipt, classifies the outcome.
// ABOUTME: Shared by the multi-step pipeline store and ClaimFlow so both inherit the same tx handling.

import type { JsonRpcProvider, TransactionReceipt, TransactionResponse } from 'ethers'
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
 * @param readProvider Optional direct read provider. When supplied, its
 *   `waitForTransaction` is raced against the wallet's `tx.wait()` and the first
 *   confirmation wins — so a slow wallet provider (e.g. MetaMask's lagging poll)
 *   doesn't keep the UI on "submitting" for seconds after the chain confirmed.
 */
export async function sendAndWaitTx(
  send: () => Promise<TransactionResponse>,
  onSubmitted?: (hash: string) => void,
  readProvider?: JsonRpcProvider | null,
): Promise<TxSendResult> {
  let hash: string | undefined
  try {
    const tx = await send()
    hash = tx.hash
    onSubmitted?.(hash)
    // Confirm via the wallet's tx.wait(). When a read provider is supplied, also
    // race its waitForTransaction and take whichever confirms first. The read
    // path only accelerates the success case: its timeout resolves to `null`,
    // which we convert to a rejection so it can't win the race as a fake
    // receipt; if BOTH paths fail we fall back to the wallet wait's
    // authoritative error so timeout/revert classification below is unchanged.
    const walletWait = tx.wait(1, TX_WAIT_TIMEOUT_MS)
    let receipt: TransactionReceipt | null
    if (readProvider) {
      const readWait = readProvider
        .waitForTransaction(hash, 1, TX_WAIT_TIMEOUT_MS)
        .then((r) => (r ? r : Promise.reject(new Error('read wait timed out'))))
      receipt = await Promise.any([walletWait, readWait]).catch(() => walletWait)
    } else {
      receipt = await walletWait
    }
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

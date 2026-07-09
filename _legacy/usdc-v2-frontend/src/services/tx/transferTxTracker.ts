/**
 * Transfer Transaction Tracker
 *
 * Tracks private transfer transactions (0zk → 0zk) from initiation to completion.
 */

import type { StoredTransaction } from '@/types/transaction'
import { createTransaction, TRANSFER_STAGES } from '@/types/transaction'
import {
  saveTransaction,
  getTransaction,
  updateTxStage,
  confirmTxStage,
  completeTx,
  failTx,
  setMainTxHash,
} from './privacyPoolTxStorage'
import { waitForTransaction } from './privacyPoolEventPoller'

// ============ Types ============

export interface TransferTxParams {
  /** Human-readable amount */
  amount: string
  /** Amount in base units */
  amountRaw: string
  /** Token symbol */
  tokenSymbol: string
  /** Sender's Railgun address */
  senderRailgunAddress: string
  /** Recipient's Railgun address */
  recipientRailgunAddress: string
}

export interface TransferTxCallbacks {
  onStageChange?: (tx: StoredTransaction) => void
  onComplete?: (tx: StoredTransaction) => void
  onError?: (tx: StoredTransaction, error: Error) => void
}

// ============ Tracker Functions ============

/**
 * Initialize a new transfer transaction
 */
export function initTransferTransaction(params: TransferTxParams): StoredTransaction {
  const tx = createTransaction({
    flowType: 'transfer',
    status: 'pending',
    amount: params.amount,
    amountRaw: params.amountRaw,
    tokenSymbol: params.tokenSymbol,
    sourceChain: 'hub',
    isCrossChain: false,
    railgunAddress: params.senderRailgunAddress,
    recipientAddress: params.recipientRailgunAddress,
    txHashes: {},
  })

  saveTransaction(tx)
  console.log('[transfer-tracker] Initialized transaction:', tx.id)

  return tx
}

/**
 * Mark proof generation as started
 */
export function markProofGenerating(
  txId: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, TRANSFER_STAGES.PROOF_GENERATING, {
    status: 'active',
    message: 'Generating zero-knowledge proof...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Update proof generation progress
 */
export function updateProofProgress(
  txId: string,
  progress: number,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  const percentage = Math.round(progress * 100)
  const tx = updateTxStage(txId, TRANSFER_STAGES.PROOF_GENERATING, {
    message: `Generating proof... ${percentage}%`,
    metadata: { progress },
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark proof generation as complete
 */
export function markProofComplete(
  txId: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  const tx = confirmTxStage(txId, TRANSFER_STAGES.PROOF_GENERATING, {
    message: 'Proof generated',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark transfer as pending signature
 */
export function markTransferPending(
  txId: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, TRANSFER_STAGES.TRANSFER_PENDING, {
    status: 'active',
    message: 'Waiting for signature...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark transfer as submitted
 */
export function markTransferSubmitted(
  txId: string,
  txHash: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  setMainTxHash(txId, txHash)

  // Confirm pending stage with completed message
  confirmTxStage(txId, TRANSFER_STAGES.TRANSFER_PENDING, {
    txHash,
    message: 'Transfer signature received',
  })

  // Mark submitted as active
  const tx = updateTxStage(txId, TRANSFER_STAGES.TRANSFER_SUBMITTED, {
    status: 'active',
    txHash,
    message: 'Transfer submitted, waiting for confirmation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark transfer as confirmed on-chain
 */
export function markTransferConfirmed(
  txId: string,
  blockNumber: number,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  // Confirm submitted stage with completed message
  confirmTxStage(txId, TRANSFER_STAGES.TRANSFER_SUBMITTED, {
    blockNumber,
    message: 'Transfer transaction confirmed',
  })

  // Confirm the confirmed stage
  const tx = confirmTxStage(txId, TRANSFER_STAGES.TRANSFER_CONFIRMED, {
    blockNumber,
    message: 'Transfer confirmed on-chain',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark balance update stage
 */
export function markBalanceUpdating(
  txId: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, TRANSFER_STAGES.BALANCE_UPDATING, {
    status: 'active',
    message: 'Updating shielded balance...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark transfer as completed
 */
export function markTransferCompleted(
  txId: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  // Confirm balance updating stage with completed message
  confirmTxStage(txId, TRANSFER_STAGES.BALANCE_UPDATING, {
    message: 'Balance updated',
  })

  // Complete the transaction
  const tx = completeTx(txId)

  if (tx) {
    callbacks?.onComplete?.(tx)
  }

  return tx
}

/**
 * Mark transfer as failed
 */
export function markTransferFailed(
  txId: string,
  error: Error,
  stageId?: string,
  callbacks?: TransferTxCallbacks,
): StoredTransaction | undefined {
  const tx = failTx(txId, error.message, stageId)

  if (tx) {
    callbacks?.onError?.(tx, error)
  }

  return tx
}

// ============ Polling Helpers ============

/**
 * Wait for a transfer transaction to confirm on-chain
 */
export async function waitForTransferConfirmation(
  txId: string,
  txHash: string,
  chainKey: string = 'hub',
  callbacks?: TransferTxCallbacks,
  timeoutMs: number = 120000,
): Promise<StoredTransaction | undefined> {
  console.log('[transfer-tracker] Waiting for confirmation:', txHash)

  const result = await waitForTransaction(txHash, chainKey, timeoutMs)

  if (result.error) {
    return markTransferFailed(
      txId,
      new Error(result.error),
      TRANSFER_STAGES.TRANSFER_SUBMITTED,
      callbacks,
    )
  }

  if (result.confirmed && result.blockNumber) {
    markTransferConfirmed(txId, result.blockNumber, callbacks)
    markBalanceUpdating(txId, callbacks)
    return markTransferCompleted(txId, callbacks)
  }

  return getTransaction(txId)
}

// ============ Convenience Function ============

/**
 * Track a complete transfer flow
 *
 * This is a convenience function that handles the full lifecycle.
 * For more control, use the individual stage functions.
 */
export async function trackTransferTransaction(
  params: TransferTxParams,
  executeFn: (
    onProofProgress: (progress: number) => void,
  ) => Promise<{ txHash: string }>,
  callbacks?: TransferTxCallbacks,
): Promise<StoredTransaction | undefined> {
  // Initialize
  const tx = initTransferTransaction(params)
  const txId = tx.id

  try {
    // Proof generation
    markProofGenerating(txId, callbacks)

    const result = await executeFn((progress) => {
      updateProofProgress(txId, progress, callbacks)
    })

    markProofComplete(txId, callbacks)

    // Submission
    markTransferPending(txId, callbacks)
    markTransferSubmitted(txId, result.txHash, callbacks)

    // Confirmation
    return await waitForTransferConfirmation(txId, result.txHash, 'hub', callbacks)
  } catch (error) {
    const currentTx = getTransaction(txId)
    return markTransferFailed(
      txId,
      error instanceof Error ? error : new Error('Unknown error'),
      currentTx?.currentStageId,
      callbacks,
    )
  }
}

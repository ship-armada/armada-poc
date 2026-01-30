/**
 * Shield Transaction Tracker
 *
 * Tracks shield transactions from initiation to completion.
 * Supports both direct hub shielding and cross-chain shielding via CCTP.
 */

import type { StoredTransaction } from '@/types/transaction'
import { createTransaction, SHIELD_STAGES } from '@/types/transaction'
import {
  saveTransaction,
  getTransaction,
  updateTxStage,
  confirmTxStage,
  completeTx,
  failTx,
  setMainTxHash,
  setApprovalTxHash,
  setRelayTxHash,
  updateCCTPMetadata,
} from './privacyPoolTxStorage'
import { waitForTransaction } from './privacyPoolEventPoller'

// ============ Types ============

export interface ShieldTxParams {
  /** Human-readable amount */
  amount: string
  /** Amount in base units */
  amountRaw: string
  /** Token symbol */
  tokenSymbol: string
  /** Source chain key */
  sourceChain: 'hub' | 'client-a' | 'client-b'
  /** Public address sending the tokens */
  publicAddress: string
  /** Railgun address receiving the shielded tokens */
  railgunAddress: string
  /** Whether this is a cross-chain shield */
  isCrossChain: boolean
}

export interface ShieldTxCallbacks {
  onStageChange?: (tx: StoredTransaction) => void
  onComplete?: (tx: StoredTransaction) => void
  onError?: (tx: StoredTransaction, error: Error) => void
}

// ============ Tracker Functions ============

/**
 * Initialize a new shield transaction
 */
export function initShieldTransaction(params: ShieldTxParams): StoredTransaction {
  const tx = createTransaction({
    flowType: 'shield',
    status: 'pending',
    amount: params.amount,
    amountRaw: params.amountRaw,
    tokenSymbol: params.tokenSymbol,
    sourceChain: params.sourceChain,
    destinationChain: 'hub',
    isCrossChain: params.isCrossChain,
    publicAddress: params.publicAddress,
    railgunAddress: params.railgunAddress,
    txHashes: {},
  })

  saveTransaction(tx)
  console.log('[shield-tracker] Initialized transaction:', tx.id)

  return tx
}

/**
 * Update approval stage - started
 */
export function markApprovalPending(
  txId: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, SHIELD_STAGES.APPROVAL_PENDING, {
    status: 'active',
    message: 'Waiting for approval signature...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Update approval stage - tx hash received
 */
export function markApprovalSubmitted(
  txId: string,
  txHash: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  setApprovalTxHash(txId, txHash)

  const tx = updateTxStage(txId, SHIELD_STAGES.APPROVAL_PENDING, {
    txHash,
    message: 'Approval submitted, waiting for confirmation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Update approval stage - confirmed
 */
export function markApprovalConfirmed(
  txId: string,
  blockNumber?: number,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  // Confirm approval_pending stage
  confirmTxStage(txId, SHIELD_STAGES.APPROVAL_PENDING, {
    blockNumber,
    message: 'Approval transaction confirmed',
  })

  // Also confirm approval_confirmed stage (it's a checkpoint stage)
  const tx = confirmTxStage(txId, SHIELD_STAGES.APPROVAL_CONFIRMED, {
    blockNumber,
    message: 'Approval confirmed',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark shield transaction as pending signature
 */
export function markShieldPending(
  txId: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, SHIELD_STAGES.SHIELD_PENDING, {
    status: 'active',
    message: 'Waiting for shield signature...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark shield transaction as submitted
 */
export function markShieldSubmitted(
  txId: string,
  txHash: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  setMainTxHash(txId, txHash)

  // First update shield_pending to confirmed with completed message
  confirmTxStage(txId, SHIELD_STAGES.SHIELD_PENDING, {
    txHash,
    message: 'Shield signature received',
  })

  // Then mark shield_submitted as active
  const tx = updateTxStage(txId, SHIELD_STAGES.SHIELD_SUBMITTED, {
    status: 'active',
    txHash,
    message: 'Shield submitted, waiting for confirmation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark shield transaction as confirmed on-chain
 */
export function markShieldConfirmed(
  txId: string,
  blockNumber: number,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  // Confirm submitted stage with completed message
  confirmTxStage(txId, SHIELD_STAGES.SHIELD_SUBMITTED, {
    blockNumber,
    message: 'Shield transaction confirmed',
  })

  // Confirm the confirmed stage
  const tx = confirmTxStage(txId, SHIELD_STAGES.SHIELD_CONFIRMED, {
    blockNumber,
    message: 'Shield confirmed on-chain',
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
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, SHIELD_STAGES.BALANCE_UPDATING, {
    status: 'active',
    message: 'Updating shielded balance...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark shield transaction as completed
 */
export function markShieldCompleted(
  txId: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  // Confirm balance updating stage with completed message
  confirmTxStage(txId, SHIELD_STAGES.BALANCE_UPDATING, {
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
 * Mark shield transaction as failed
 */
export function markShieldFailed(
  txId: string,
  error: Error,
  stageId?: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = failTx(txId, error.message, stageId)

  if (tx) {
    callbacks?.onError?.(tx, error)
  }

  return tx
}

// ============ Cross-Chain Shield Stages ============

/**
 * Mark CCTP burn as pending
 */
export function markCCTPBurnPending(
  txId: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, SHIELD_STAGES.CCTP_BURN_PENDING, {
    status: 'active',
    message: 'Waiting for CCTP burn signature...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark CCTP burn as submitted
 */
export function markCCTPBurnSubmitted(
  txId: string,
  txHash: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  setMainTxHash(txId, txHash)

  // Confirm pending stage with completed message
  confirmTxStage(txId, SHIELD_STAGES.CCTP_BURN_PENDING, {
    txHash,
    message: 'CCTP burn signature received',
  })

  const tx = updateTxStage(txId, SHIELD_STAGES.CCTP_BURN_SUBMITTED, {
    status: 'active',
    txHash,
    message: 'CCTP burn submitted, waiting for confirmation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark CCTP burn as confirmed
 */
export function markCCTPBurnConfirmed(
  txId: string,
  blockNumber: number,
  nonce?: number,
  messageHash?: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  // Confirm submitted stage with completed message
  confirmTxStage(txId, SHIELD_STAGES.CCTP_BURN_SUBMITTED, {
    blockNumber,
    message: 'CCTP burn confirmed',
  })

  if (nonce !== undefined || messageHash) {
    updateCCTPMetadata(txId, { nonce, messageHash })
  }

  const tx = confirmTxStage(txId, SHIELD_STAGES.CCTP_BURN_CONFIRMED, {
    blockNumber,
    message: 'Burn confirmed',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark attestation as pending
 */
export function markAttestationPending(
  txId: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, SHIELD_STAGES.CCTP_ATTESTATION_PENDING, {
    status: 'active',
    message: 'Waiting for Circle attestation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark attestation as received
 */
export function markAttestationReceived(
  txId: string,
  attestation: string,
  messageBytes: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  updateCCTPMetadata(txId, { attestation, messageBytes })

  const tx = confirmTxStage(txId, SHIELD_STAGES.CCTP_ATTESTATION_PENDING, {
    message: 'Attestation received',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark relay as pending
 */
export function markRelayPending(
  txId: string,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  // Confirm attestation received stage with completed message
  confirmTxStage(txId, SHIELD_STAGES.CCTP_ATTESTATION_RECEIVED, {
    message: 'Attestation confirmed',
  })

  const tx = updateTxStage(txId, SHIELD_STAGES.CCTP_RELAY_PENDING, {
    status: 'active',
    message: 'Relaying to hub chain...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark mint as confirmed (cross-chain shield complete)
 */
export function markCCTPMintConfirmed(
  txId: string,
  relayTxHash: string,
  blockNumber: number,
  callbacks?: ShieldTxCallbacks,
): StoredTransaction | undefined {
  setRelayTxHash(txId, relayTxHash)

  // Confirm relay pending stage with completed message
  confirmTxStage(txId, SHIELD_STAGES.CCTP_RELAY_PENDING, {
    txHash: relayTxHash,
    message: 'Relay completed',
  })

  const tx = confirmTxStage(txId, SHIELD_STAGES.CCTP_MINT_CONFIRMED, {
    blockNumber,
    txHash: relayTxHash,
    message: 'USDC minted and shielded',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

// ============ Polling Helpers ============

/**
 * Wait for a shield transaction to confirm on-chain
 */
export async function waitForShieldConfirmation(
  txId: string,
  txHash: string,
  chainKey: string,
  callbacks?: ShieldTxCallbacks,
  timeoutMs: number = 120000,
): Promise<StoredTransaction | undefined> {
  console.log('[shield-tracker] Waiting for confirmation:', txHash)

  const result = await waitForTransaction(txHash, chainKey, timeoutMs)

  if (result.error) {
    return markShieldFailed(
      txId,
      new Error(result.error),
      SHIELD_STAGES.SHIELD_SUBMITTED,
      callbacks,
    )
  }

  if (result.confirmed && result.blockNumber) {
    markShieldConfirmed(txId, result.blockNumber, callbacks)
    markBalanceUpdating(txId, callbacks)
    return markShieldCompleted(txId, callbacks)
  }

  return getTransaction(txId)
}

/**
 * Wait for CCTP burn to confirm
 */
export async function waitForCCTPBurnConfirmation(
  txId: string,
  txHash: string,
  chainKey: string,
  callbacks?: ShieldTxCallbacks,
  timeoutMs: number = 120000,
): Promise<StoredTransaction | undefined> {
  console.log('[shield-tracker] Waiting for CCTP burn confirmation:', txHash)

  const result = await waitForTransaction(txHash, chainKey, timeoutMs)

  if (result.error) {
    return markShieldFailed(
      txId,
      new Error(result.error),
      SHIELD_STAGES.CCTP_BURN_SUBMITTED,
      callbacks,
    )
  }

  if (result.confirmed && result.blockNumber) {
    // Extract CCTP data from events if available
    const messageSentEvent = result.events.find((e) => e.eventName === 'MessageSent')

    return markCCTPBurnConfirmed(
      txId,
      result.blockNumber,
      messageSentEvent?.data?.nonce as number | undefined,
      messageSentEvent?.data?.messageHash as string | undefined,
      callbacks,
    )
  }

  return getTransaction(txId)
}

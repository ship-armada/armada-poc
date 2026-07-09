/**
 * Unshield Transaction Tracker
 *
 * Tracks unshield transactions from initiation to completion.
 * Supports both local hub unshielding and cross-chain unshielding via CCTP.
 */

import type { StoredTransaction, ChainScope } from '@/types/transaction'
import { createTransaction, UNSHIELD_STAGES } from '@/types/transaction'
import {
  saveTransaction,
  getTransaction,
  updateTxStage,
  confirmTxStage,
  completeTx,
  failTx,
  setMainTxHash,
  setRelayTxHash,
  updateCCTPMetadata,
} from './privacyPoolTxStorage'
import {
  waitForTransaction,
  pollForUnshieldReceivedEvent,
} from './privacyPoolEventPoller'

// ============ Types ============

export interface UnshieldTxParams {
  /** Human-readable amount */
  amount: string
  /** Amount in base units */
  amountRaw: string
  /** Token symbol */
  tokenSymbol: string
  /** Sender's Railgun address */
  railgunAddress: string
  /** Recipient's public Ethereum address */
  recipientAddress: string
  /** Destination chain key */
  destinationChain: ChainScope
  /** Whether this is a cross-chain unshield */
  isCrossChain: boolean
}

export interface UnshieldTxCallbacks {
  onStageChange?: (tx: StoredTransaction) => void
  onComplete?: (tx: StoredTransaction) => void
  onError?: (tx: StoredTransaction, error: Error) => void
}

// ============ Tracker Functions ============

/**
 * Initialize a new unshield transaction
 */
export function initUnshieldTransaction(params: UnshieldTxParams): StoredTransaction {
  const tx = createTransaction({
    flowType: 'unshield',
    status: 'pending',
    amount: params.amount,
    amountRaw: params.amountRaw,
    tokenSymbol: params.tokenSymbol,
    sourceChain: 'hub',
    destinationChain: params.destinationChain,
    isCrossChain: params.isCrossChain,
    railgunAddress: params.railgunAddress,
    recipientAddress: params.recipientAddress,
    txHashes: {},
  })

  saveTransaction(tx)
  console.log('[unshield-tracker] Initialized transaction:', tx.id)

  return tx
}

/**
 * Mark proof generation as started
 */
export function markProofGenerating(
  txId: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, UNSHIELD_STAGES.PROOF_GENERATING, {
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
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const percentage = Math.round(progress * 100)
  const tx = updateTxStage(txId, UNSHIELD_STAGES.PROOF_GENERATING, {
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
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = confirmTxStage(txId, UNSHIELD_STAGES.PROOF_GENERATING, {
    message: 'Proof generated',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark unshield as pending signature
 */
export function markUnshieldPending(
  txId: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, UNSHIELD_STAGES.UNSHIELD_PENDING, {
    status: 'active',
    message: 'Waiting for signature...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark unshield as submitted
 */
export function markUnshieldSubmitted(
  txId: string,
  txHash: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  setMainTxHash(txId, txHash)

  // Confirm pending stage with completed message
  confirmTxStage(txId, UNSHIELD_STAGES.UNSHIELD_PENDING, {
    txHash,
    message: 'Unshield signature received',
  })

  // Mark submitted as active
  const tx = updateTxStage(txId, UNSHIELD_STAGES.UNSHIELD_SUBMITTED, {
    status: 'active',
    txHash,
    message: 'Unshield submitted, waiting for confirmation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark unshield as confirmed on-chain
 */
export function markUnshieldConfirmed(
  txId: string,
  blockNumber: number,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  // Confirm submitted stage with completed message
  confirmTxStage(txId, UNSHIELD_STAGES.UNSHIELD_SUBMITTED, {
    blockNumber,
    message: 'Unshield transaction confirmed',
  })

  // Confirm the confirmed stage
  const tx = confirmTxStage(txId, UNSHIELD_STAGES.UNSHIELD_CONFIRMED, {
    blockNumber,
    message: 'Unshield confirmed on-chain',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark balance update stage (for local unshield)
 */
export function markBalanceUpdating(
  txId: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, UNSHIELD_STAGES.BALANCE_UPDATING, {
    status: 'active',
    message: 'Updating balance...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark unshield as completed
 */
export function markUnshieldCompleted(
  txId: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  // Complete the transaction
  const tx = completeTx(txId)

  if (tx) {
    callbacks?.onComplete?.(tx)
  }

  return tx
}

/**
 * Mark unshield as failed
 */
export function markUnshieldFailed(
  txId: string,
  error: Error,
  stageId?: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = failTx(txId, error.message, stageId)

  if (tx) {
    callbacks?.onError?.(tx, error)
  }

  return tx
}

// ============ Cross-Chain Unshield Stages ============

/**
 * Mark CCTP attestation as pending
 */
export function markCCTPAttestationPending(
  txId: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, UNSHIELD_STAGES.CCTP_ATTESTATION_PENDING, {
    status: 'active',
    message: 'Waiting for Circle attestation...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark CCTP attestation as received
 */
export function markCCTPAttestationReceived(
  txId: string,
  attestation: string,
  messageBytes: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  updateCCTPMetadata(txId, { attestation, messageBytes })

  confirmTxStage(txId, UNSHIELD_STAGES.CCTP_ATTESTATION_PENDING, {
    message: 'Attestation received',
  })

  // Also confirm attestation_received stage with message
  const tx = confirmTxStage(txId, UNSHIELD_STAGES.CCTP_ATTESTATION_RECEIVED, {
    message: 'Attestation confirmed',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark CCTP relay as pending
 */
export function markCCTPRelayPending(
  txId: string,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  const tx = updateTxStage(txId, UNSHIELD_STAGES.CCTP_RELAY_PENDING, {
    status: 'active',
    message: 'Relaying to destination chain...',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

/**
 * Mark CCTP mint as confirmed (cross-chain unshield complete)
 */
export function markCCTPMintConfirmed(
  txId: string,
  relayTxHash: string,
  blockNumber: number,
  callbacks?: UnshieldTxCallbacks,
): StoredTransaction | undefined {
  setRelayTxHash(txId, relayTxHash)

  // Confirm relay pending stage with completed message
  confirmTxStage(txId, UNSHIELD_STAGES.CCTP_RELAY_PENDING, {
    txHash: relayTxHash,
    message: 'Relay completed',
  })

  const tx = confirmTxStage(txId, UNSHIELD_STAGES.CCTP_MINT_CONFIRMED, {
    blockNumber,
    txHash: relayTxHash,
    message: 'USDC received on destination chain',
  })

  if (tx) {
    callbacks?.onStageChange?.(tx)
  }

  return tx
}

// ============ Polling Helpers ============

/**
 * Wait for a local unshield transaction to confirm on-chain
 */
export async function waitForUnshieldConfirmation(
  txId: string,
  txHash: string,
  chainKey: string = 'hub',
  callbacks?: UnshieldTxCallbacks,
  timeoutMs: number = 120000,
): Promise<StoredTransaction | undefined> {
  console.log('[unshield-tracker] Waiting for confirmation:', txHash)

  const result = await waitForTransaction(txHash, chainKey, timeoutMs)

  if (result.error) {
    return markUnshieldFailed(
      txId,
      new Error(result.error),
      UNSHIELD_STAGES.UNSHIELD_SUBMITTED,
      callbacks,
    )
  }

  if (result.confirmed && result.blockNumber) {
    markUnshieldConfirmed(txId, result.blockNumber, callbacks)
    markBalanceUpdating(txId, callbacks)
    return markUnshieldCompleted(txId, callbacks)
  }

  return getTransaction(txId)
}

/**
 * Wait for cross-chain unshield to complete
 *
 * This monitors the destination chain for the UnshieldReceived event.
 */
export async function waitForCrossChainUnshieldComplete(
  txId: string,
  clientContractAddress: string,
  destinationChainKey: string,
  recipientAddress: string,
  fromBlock: number,
  callbacks?: UnshieldTxCallbacks,
  maxAttempts: number = 60,
  pollIntervalMs: number = 5000,
): Promise<StoredTransaction | undefined> {
  console.log('[unshield-tracker] Waiting for cross-chain completion on:', destinationChainKey)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await pollForUnshieldReceivedEvent(
      clientContractAddress,
      destinationChainKey,
      fromBlock,
      recipientAddress,
    )

    if (result.found && result.events.length > 0) {
      const event = result.events[0]
      markCCTPMintConfirmed(txId, event.txHash, event.blockNumber, callbacks)
      return markUnshieldCompleted(txId, callbacks)
    }

    if (result.error) {
      console.warn('[unshield-tracker] Poll error:', result.error)
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  // Timeout
  return markUnshieldFailed(
    txId,
    new Error('Cross-chain unshield timeout'),
    UNSHIELD_STAGES.CCTP_RELAY_PENDING,
    callbacks,
  )
}

// ============ Convenience Function ============

/**
 * Track a complete local unshield flow
 */
export async function trackLocalUnshieldTransaction(
  params: UnshieldTxParams,
  executeFn: (
    onProofProgress: (progress: number) => void,
  ) => Promise<{ txHash: string }>,
  callbacks?: UnshieldTxCallbacks,
): Promise<StoredTransaction | undefined> {
  // Initialize
  const tx = initUnshieldTransaction({ ...params, isCrossChain: false })
  const txId = tx.id

  try {
    // Proof generation
    markProofGenerating(txId, callbacks)

    const result = await executeFn((progress) => {
      updateProofProgress(txId, progress, callbacks)
    })

    markProofComplete(txId, callbacks)

    // Submission
    markUnshieldPending(txId, callbacks)
    markUnshieldSubmitted(txId, result.txHash, callbacks)

    // Confirmation
    return await waitForUnshieldConfirmation(txId, result.txHash, 'hub', callbacks)
  } catch (error) {
    const currentTx = getTransaction(txId)
    return markUnshieldFailed(
      txId,
      error instanceof Error ? error : new Error('Unknown error'),
      currentTx?.currentStageId,
      callbacks,
    )
  }
}

/**
 * Track a cross-chain unshield flow
 *
 * Note: This only tracks up to the hub confirmation.
 * The CCTP relay is handled separately by a background process.
 */
export async function trackCrossChainUnshieldTransaction(
  params: UnshieldTxParams,
  executeFn: (
    onProofProgress: (progress: number) => void,
  ) => Promise<{ txHash: string }>,
  callbacks?: UnshieldTxCallbacks,
): Promise<StoredTransaction | undefined> {
  // Initialize
  const tx = initUnshieldTransaction({ ...params, isCrossChain: true })
  const txId = tx.id

  try {
    // Proof generation
    markProofGenerating(txId, callbacks)

    const result = await executeFn((progress) => {
      updateProofProgress(txId, progress, callbacks)
    })

    markProofComplete(txId, callbacks)

    // Submission
    markUnshieldPending(txId, callbacks)
    markUnshieldSubmitted(txId, result.txHash, callbacks)

    // Wait for hub confirmation
    const hubResult = await waitForTransaction(result.txHash, 'hub', 120000)

    if (hubResult.error) {
      return markUnshieldFailed(
        txId,
        new Error(hubResult.error),
        UNSHIELD_STAGES.UNSHIELD_SUBMITTED,
        callbacks,
      )
    }

    if (hubResult.confirmed && hubResult.blockNumber) {
      markUnshieldConfirmed(txId, hubResult.blockNumber, callbacks)
      markCCTPAttestationPending(txId, callbacks)

      // Return transaction - CCTP tracking continues separately
      return getTransaction(txId)
    }

    return getTransaction(txId)
  } catch (error) {
    const currentTx = getTransaction(txId)
    return markUnshieldFailed(
      txId,
      error instanceof Error ? error : new Error('Unknown error'),
      currentTx?.currentStageId,
      callbacks,
    )
  }
}

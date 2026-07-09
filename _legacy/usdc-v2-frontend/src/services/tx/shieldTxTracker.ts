/**
 * Shield Transaction Tracker
 *
 * Tracks shield transactions from initiation to completion.
 * Supports both direct hub shielding and cross-chain shielding via CCTP.
 */

import { ethers } from 'ethers'
import type { StoredTransaction } from '@/types/transaction'
import { createTransaction, SHIELD_STAGES } from '@/types/transaction'
import {
  saveTransaction,
  getTransaction,
  getAllTransactions,
  updateTransaction,
  updateTxStage,
  confirmTxStage,
  completeTx,
  failTx,
  setMainTxHash,
  setApprovalTxHash,
  setRelayTxHash,
  updateCCTPMetadata,
  getPendingTransactions,
} from './privacyPoolTxStorage'
import { waitForTransaction } from './privacyPoolEventPoller'
import { getEvmProvider } from '@/services/evm/evmNetworkService'
import { extractMessageSent, pollIrisAttestation } from '@/services/polling/irisAttestationService'
import { queryMessageReceivedByNonce } from '@/services/polling/evmPoller'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { getAttestationTimeoutMs, getRelayTimeoutMs } from '@/config/networkConfig'
import { findChainByKey } from '@/config/chains'
import { isSepoliaMode } from '@/config/networkConfig'

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
  nonce?: string,
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
      messageSentEvent?.data?.nonce as string | undefined,
      messageSentEvent?.data?.messageHash as string | undefined,
      callbacks,
    )
  }

  return getTransaction(txId)
}

// ============ Cross-Chain Shield Completion Tracking ============

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Track the full cross-chain shield CCTP flow in the background.
 *
 * Progresses through: burn confirmed → attestation → relay detected → mint confirmed → completed.
 *
 * This function is fire-and-forget — it catches all errors internally and marks the
 * transaction as failed at the appropriate stage. It never throws.
 */
export async function trackCrossChainShieldCompletion(
  txId: string,
  burnTxHash: string,
  sourceChainKey: string,
  hubChainKey: string = 'hub',
  callbacks?: ShieldTxCallbacks,
  /** How many blocks back from current to start relay detection (default: 10, set higher when resuming) */
  relayBlocksBack?: number,
): Promise<StoredTransaction | undefined> {
  const LOG_TAG = '[shield-cctp-tracker]'

  try {
    // ── Phase 1: Wait for burn tx confirmation on client chain ──
    console.log(`${LOG_TAG} Phase 1: Waiting for burn tx confirmation on ${sourceChainKey}...`)
    const burnResult = await waitForCCTPBurnConfirmation(txId, burnTxHash, sourceChainKey, callbacks)

    // Check if burn confirmation failed (transaction was marked as failed inside)
    const txAfterBurn = getTransaction(txId)
    if (!txAfterBurn || txAfterBurn.status === 'error') {
      console.error(`${LOG_TAG} Burn confirmation failed, stopping`)
      return txAfterBurn
    }

    // ── Phase 2: Extract MessageSent data and poll Iris attestation ──
    console.log(`${LOG_TAG} Phase 2: Extracting MessageSent event from burn tx...`)

    let provider: ethers.JsonRpcProvider
    try {
      provider = await getEvmProvider(sourceChainKey)
    } catch (err) {
      console.error(`${LOG_TAG} Failed to get provider for ${sourceChainKey}:`, err)
      return markShieldFailed(txId, new Error(`Failed to get provider for ${sourceChainKey}`), SHIELD_STAGES.CCTP_BURN_CONFIRMED, callbacks)
    }

    const extraction = await extractMessageSent(burnTxHash, sourceChainKey, provider)
    if (!extraction.success || !extraction.data) {
      console.error(`${LOG_TAG} Failed to extract MessageSent:`, extraction.error)
      return markShieldFailed(txId, new Error(extraction.error || 'Failed to extract MessageSent event'), SHIELD_STAGES.CCTP_BURN_CONFIRMED, callbacks)
    }

    const { irisLookupID, sourceDomain, destinationDomain, messageBytes } = extraction.data
    let nonce = extraction.data.nonce

    console.log(`${LOG_TAG} MessageSent extracted: nonce=${nonce}, irisLookupID=${irisLookupID}`)

    // Store CCTP metadata
    updateCCTPMetadata(txId, { nonce, sourceDomain, destinationDomain, messageHash: irisLookupID })

    // Mark attestation pending
    markAttestationPending(txId, callbacks)

    if (isSepoliaMode()) {
      // Real Iris attestation polling (Sepolia)
      const attestationTimeoutSec = Math.round(getAttestationTimeoutMs() / 1000)
      console.log(`${LOG_TAG} Phase 2b: Polling Iris API for attestation (up to ${attestationTimeoutSec}s)...`)

      const irisResult = await pollIrisAttestation(
        {
          txHash: burnTxHash,
          chainId: sourceChainKey,
          flowId: txId,
          timeoutMs: getAttestationTimeoutMs(),
          pollIntervalMs: 5_000,
          sourceDomain, // enables v2 API: /v2/messages/{sourceDomain}?transactionHash={txHash}
        },
        irisLookupID,
      )

      if (!irisResult.success || !irisResult.attestation) {
        console.error(`${LOG_TAG} Iris attestation polling failed:`, irisResult.error)
        return markShieldFailed(txId, new Error(irisResult.error || 'Attestation polling timed out'), SHIELD_STAGES.CCTP_ATTESTATION_PENDING, callbacks)
      }

      // In real CCTP V2, the nonce is ZERO in the source chain's MessageSent bytes.
      // The attestation service assigns the real nonce and returns the full attested message.
      // Extract the real nonce from the Iris response message for Phase 3 relay detection.
      if (irisResult.irisMessage) {
        const irisMsg = irisResult.irisMessage
        const msgHex = irisMsg.startsWith('0x') ? irisMsg.slice(2) : irisMsg
        const realNonce = '0x' + msgHex.slice(24, 88) // bytes 12-44 = nonce (bytes32)
        console.log(`${LOG_TAG} Real nonce from Iris attested message: ${realNonce}`)
        nonce = realNonce
        // Update stored CCTP metadata with the real nonce
        updateCCTPMetadata(txId, { nonce: realNonce })
      }

      console.log(`${LOG_TAG} Attestation received`)
      markAttestationReceived(txId, irisResult.attestation, irisResult.irisMessage || ethers.hexlify(messageBytes), callbacks)
    } else {
      // Local mode: skip attestation polling (mock relayer auto-relays)
      console.log(`${LOG_TAG} Local mode: skipping Iris attestation polling`)
      // Mark attestation stages as confirmed to advance the timeline
      confirmTxStage(txId, SHIELD_STAGES.CCTP_ATTESTATION_PENDING, {
        message: 'Attestation skipped (local mode)',
      })
    }

    // ── Phase 3: Detect relay on hub chain ──
    console.log(`${LOG_TAG} Phase 3: Detecting relay on hub chain...`)
    markRelayPending(txId, callbacks)

    let hubProvider: ethers.JsonRpcProvider
    try {
      hubProvider = await getEvmProvider(hubChainKey)
    } catch (err) {
      console.error(`${LOG_TAG} Failed to get hub provider:`, err)
      return markShieldFailed(txId, new Error(`Failed to get provider for ${hubChainKey}`), SHIELD_STAGES.CCTP_RELAY_PENDING, callbacks)
    }

    // Get messageTransmitter address from hub chain config
    const chainsConfig = await fetchEvmChainsConfig()
    const hubChain = findChainByKey(chainsConfig, hubChainKey)
    const messageTransmitterAddress = hubChain?.contracts?.messageTransmitter
    if (!messageTransmitterAddress) {
      console.error(`${LOG_TAG} No messageTransmitter address configured for ${hubChainKey}`)
      return markShieldFailed(txId, new Error(`MessageTransmitter address not configured for ${hubChainKey}`), SHIELD_STAGES.CCTP_RELAY_PENDING, callbacks)
    }

    // Start polling from a few blocks back for safety
    // When resuming after page reload, relayBlocksBack is set higher to scan further back
    const currentBlock = await hubProvider.getBlockNumber()
    const blocksBack = relayBlocksBack ?? 10
    const fromBlock = BigInt(Math.max(0, currentBlock - blocksBack))
    const maxBlockRange = 2000n
    const relayTimeoutMs = getRelayTimeoutMs()
    const relayPollIntervalMs = isSepoliaMode() ? 10_000 : 2_000
    const relayDeadline = Date.now() + relayTimeoutMs
    let currentFromBlock = fromBlock

    console.log(`${LOG_TAG} Polling for MessageReceived with nonce=${nonce} on hub from block ${fromBlock}`)

    let relayTxHash: string | undefined
    let relayBlockNumber: number | undefined

    while (Date.now() < relayDeadline) {
      try {
        const latestBlock = BigInt(await hubProvider.getBlockNumber())
        if (latestBlock < currentFromBlock) {
          await sleep(relayPollIntervalMs)
          continue
        }

        // Query in block range chunks
        let chunkStart = currentFromBlock
        while (chunkStart <= latestBlock) {
          const chunkEnd = chunkStart + maxBlockRange - 1n < latestBlock
            ? chunkStart + maxBlockRange - 1n
            : latestBlock

          const logs = await queryMessageReceivedByNonce(hubProvider, {
            messageTransmitterAddress,
            nonce,
            fromBlock: chunkStart,
            toBlock: chunkEnd,
          })

          if (logs.length > 0) {
            const log = logs[0]
            relayTxHash = log.transactionHash
            relayBlockNumber = log.blockNumber
            break
          }

          chunkStart = chunkEnd + 1n
        }

        if (relayTxHash) break

        currentFromBlock = latestBlock + 1n
        await sleep(relayPollIntervalMs)
      } catch (err) {
        console.warn(`${LOG_TAG} Relay poll error (will retry):`, err instanceof Error ? err.message : err)
        await sleep(relayPollIntervalMs)
      }
    }

    if (!relayTxHash || relayBlockNumber === undefined) {
      console.error(`${LOG_TAG} Relay detection timed out after ${relayTimeoutMs}ms`)
      return markShieldFailed(txId, new Error('CCTP relay detection timed out'), SHIELD_STAGES.CCTP_RELAY_PENDING, callbacks)
    }

    console.log(`${LOG_TAG} Relay detected: tx=${relayTxHash}, block=${relayBlockNumber}`)

    // ── Phase 4: Complete ──
    markCCTPMintConfirmed(txId, relayTxHash, relayBlockNumber, callbacks)
    markBalanceUpdating(txId, callbacks)
    const completedTx = markShieldCompleted(txId, callbacks)

    console.log(`${LOG_TAG} Cross-chain shield completed successfully`)
    return completedTx
  } catch (err) {
    console.error(`${LOG_TAG} Unexpected error:`, err)
    // Try to mark as failed at whatever stage we're at
    const currentTx = getTransaction(txId)
    if (currentTx && currentTx.status === 'pending') {
      return markShieldFailed(
        txId,
        err instanceof Error ? err : new Error(String(err)),
        currentTx.currentStageId,
        callbacks,
      )
    }
    return currentTx
  }
}

// ============ Resume On Page Load ============

/** Stages where a cross-chain shield can be resumed (past user-interactive phases) */
const RESUMABLE_SHIELD_STAGES = new Set([
  SHIELD_STAGES.CCTP_BURN_SUBMITTED,
  SHIELD_STAGES.CCTP_BURN_CONFIRMED,
  SHIELD_STAGES.CCTP_ATTESTATION_PENDING,
  SHIELD_STAGES.CCTP_ATTESTATION_RECEIVED,
  SHIELD_STAGES.CCTP_RELAY_PENDING,
  SHIELD_STAGES.CCTP_MINT_CONFIRMED,
  SHIELD_STAGES.BALANCE_UPDATING,
])

/**
 * Resume polling for any in-progress cross-chain shield transactions.
 *
 * Called on page load to pick up where we left off after a browser refresh.
 * Also recovers transactions that were erroneously marked as failed (e.g. due
 * to a previous race condition where resume ran before chain config was loaded).
 *
 * Each resumable transaction gets a fire-and-forget call to
 * `trackCrossChainShieldCompletion` which re-runs the idempotent phases
 * (burn confirmation is instant for already-mined txs, Iris returns quickly
 * for already-attested messages, and relay detection scans from an estimated
 * earlier block).
 */
export function resumePendingCrossChainShields(): number {
  const LOG_TAG = '[shield-resume]'
  const allTxs = getAllTransactions()

  // Find cross-chain shields that are either pending or erroneously failed at a CCTP stage
  const resumable = allTxs.filter((tx) => {
    if (tx.flowType !== 'shield' || !tx.isCrossChain || !tx.txHashes.main) return false
    if (!tx.currentStageId || !RESUMABLE_SHIELD_STAGES.has(tx.currentStageId)) return false

    // Pending transactions: resume normally
    if (tx.status === 'pending') return true

    // Erroneously failed transactions: recover if the error was a config/timing issue
    // (e.g. "Chain configuration not loaded" from a previous buggy resume attempt)
    if (tx.status === 'error' && tx.errorMessage?.includes('Chain configuration not loaded')) {
      return true
    }

    return false
  })

  if (resumable.length === 0) return 0

  console.log(`${LOG_TAG} Found ${resumable.length} cross-chain shield(s) to resume`)

  for (const tx of resumable) {
    const burnTxHash = tx.txHashes.main!
    const sourceChain = tx.sourceChain

    // Reset erroneously failed transactions back to pending so the tracker can proceed
    if (tx.status === 'error') {
      console.log(`${LOG_TAG} Recovering erroneously failed tx ${tx.id}: "${tx.errorMessage}"`)
      updateTransaction(tx.id, {
        status: 'pending',
        errorMessage: undefined,
      })
    }

    // Estimate how far back to scan for relay detection on the hub chain.
    // Use ~12s/block for Sepolia, add a 200-block safety margin.
    const ageMs = Date.now() - tx.createdAt
    const estimatedBlocksBack = Math.ceil(ageMs / 12_000) + 200

    console.log(
      `${LOG_TAG} Resuming ${tx.id}: stage=${tx.currentStageId}, burnTx=${burnTxHash}, ageMs=${ageMs}, blocksBack=${estimatedBlocksBack}`,
    )

    // Fire-and-forget — trackCrossChainShieldCompletion catches all errors internally
    trackCrossChainShieldCompletion(
      tx.id,
      burnTxHash,
      sourceChain,
      'hub',
      undefined, // no callbacks
      estimatedBlocksBack,
    ).catch((err) => {
      // Should not happen since the function catches internally, but just in case
      console.error(`${LOG_TAG} Unexpected error resuming ${tx.id}:`, err)
    })
  }

  return resumable.length
}

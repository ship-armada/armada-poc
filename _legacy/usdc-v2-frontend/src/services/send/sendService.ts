/**
 * Send Service
 *
 * Orchestrates the complete send flow:
 * - Private transfer (0zk → 0zk)
 * - Local unshield (0zk → 0x on hub)
 * - Cross-chain unshield (0zk → 0x on client chain via CCTP)
 *
 * Handles prover initialization, proof generation, and transaction submission.
 */

import {
  parseUSDC,
  executePrivateTransfer,
  executeUnshield,
  executeUnshieldToClientChain,
  type StageCallback,
} from '@/lib/sdk'
import { initializeProver, isProverReady } from '@/lib/railgun/prover'
import { loadDeployments, getHubChain } from '@/config/deployments'
import { getChainByKey, isHubChain } from './sendContractService'
import { ensureCorrectNetwork } from '@/services/evm/evmNetworkService'

// ============ Types ============

export interface SendTransactionParams {
  /** Human readable amount (e.g., "100.50") */
  amount: string
  /** Recipient address (0zk... for private transfer, 0x... for unshield) */
  recipientAddress: string
  /** Type of recipient address */
  recipientType: 'railgun' | 'ethereum'
  /** Destination chain for unshield (e.g., 'hub', 'client-a', 'client-b') */
  destinationChainKey?: string
}

export interface SendTransactionDetails {
  amount: string
  amountRaw: bigint
  recipientAddress: string
  txHash?: string
  isPrivateTransfer: boolean
  isCrossChain: boolean
  destinationChainName?: string
}

export type SendStage =
  | 'preparing'
  | 'init-prover'
  | 'generating-proof'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'error'

export interface SendProgress {
  stage: SendStage
  message: string
  /** Proof generation progress (0-1) */
  proofProgress?: number
}

// ============ Main Functions ============

/**
 * Execute a send transaction (transfer or unshield)
 *
 * @param params - Send parameters
 * @param walletId - Railgun wallet ID
 * @param encryptionKey - Wallet encryption key
 * @param onProgress - Progress callback
 */
export async function executeSendTransaction(
  params: SendTransactionParams,
  walletId: string,
  encryptionKey: string,
  onProgress?: (progress: SendProgress) => void,
): Promise<SendTransactionDetails> {
  const { amount, recipientAddress, recipientType, destinationChainKey } = params

  // Parse amount to base units
  const amountRaw = parseUSDC(amount)

  // Determine operation type
  const isPrivateTransfer = recipientType === 'railgun'
  const isCrossChain =
    !isPrivateTransfer && destinationChainKey && !isHubChain(destinationChainKey)

  // Build result object
  const details: SendTransactionDetails = {
    amount,
    amountRaw,
    recipientAddress,
    isPrivateTransfer,
    isCrossChain: !!isCrossChain,
    destinationChainName: destinationChainKey
      ? getChainByKey(destinationChainKey)?.name
      : undefined,
  }

  // Step 1: Prepare
  onProgress?.({ stage: 'preparing', message: 'Preparing transaction...' })

  // Load deployments to get contract addresses
  await loadDeployments()

  const hubChain = getHubChain()
  const tokenAddress = hubChain.contracts?.mockUSDC || hubChain.contracts?.usdc
  if (!tokenAddress) {
    throw new Error('No USDC address configured for hub chain')
  }

  // Ensure MetaMask is on the hub network (all send operations happen on hub)
  onProgress?.({ stage: 'preparing', message: 'Switching to Hub network...' })
  await ensureCorrectNetwork('hub')

  // Step 2: Initialize prover if needed
  if (!isProverReady()) {
    onProgress?.({ stage: 'init-prover', message: 'Initializing prover...' })
    await initializeProver()
  }

  // Step 3: Generate proof and submit transaction
  onProgress?.({
    stage: 'generating-proof',
    message: 'Generating zero-knowledge proof...',
    proofProgress: 0,
  })

  try {
    if (isPrivateTransfer) {
      // Private transfer to another Railgun address
      console.log('[send-service] Executing private transfer...')

      const result = await executePrivateTransfer(
        walletId,
        encryptionKey,
        tokenAddress,
        recipientAddress,
        amountRaw,
        (progress) => {
          onProgress?.({
            stage: 'generating-proof',
            message: `Generating proof... ${Math.round(progress * 100)}%`,
            proofProgress: progress,
          })
        },
      )

      details.txHash = result.txHash

      onProgress?.({ stage: 'success', message: 'Transfer complete!' })
      console.log('[send-service] Private transfer complete:', result.txHash)
    } else if (!isCrossChain) {
      // Local unshield on hub chain
      console.log('[send-service] Executing local unshield...')

      // Stage callback to update progress during signing/confirming
      const stageCallback: StageCallback = (stage) => {
        if (stage === 'signing') {
          onProgress?.({ stage: 'signing', message: 'Please sign the transaction...' })
        } else if (stage === 'confirming') {
          onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })
        }
      }

      const result = await executeUnshield(
        walletId,
        encryptionKey,
        tokenAddress,
        recipientAddress,
        amountRaw,
        (progress) => {
          onProgress?.({
            stage: 'generating-proof',
            message: `Generating proof... ${Math.round(progress * 100)}%`,
            proofProgress: progress,
          })
        },
        stageCallback,
      )

      details.txHash = result.txHash

      onProgress?.({ stage: 'success', message: 'Unshield complete!' })
      console.log('[send-service] Local unshield complete:', result.txHash)
    } else {
      // Cross-chain unshield via CCTP
      console.log('[send-service] Executing cross-chain unshield...')

      const privacyPoolAddress = hubChain.contracts?.privacyPool
      if (!privacyPoolAddress) {
        throw new Error('No PrivacyPool address configured for hub chain')
      }

      const destChain = getChainByKey(destinationChainKey!)
      if (!destChain) {
        throw new Error(`Unknown destination chain: ${destinationChainKey}`)
      }

      const result = await executeUnshieldToClientChain(
        walletId,
        encryptionKey,
        tokenAddress,
        privacyPoolAddress,
        amountRaw,
        destChain.chainId,
        recipientAddress,
        (progress) => {
          onProgress?.({
            stage: 'generating-proof',
            message: `Generating proof... ${Math.round(progress * 100)}%`,
            proofProgress: progress,
          })
        },
      )

      details.txHash = result.txHash

      onProgress?.({
        stage: 'success',
        message: 'Cross-chain unshield initiated! Waiting for CCTP relay...',
      })
      console.log('[send-service] Cross-chain unshield complete:', result.txHash)
    }

    // Log transaction details for debugging (stub for future tx storage)
    console.log('[send-service] Transaction completed:', {
      txHash: details.txHash,
      amount: details.amount,
      recipient: details.recipientAddress,
      type: details.isPrivateTransfer
        ? 'private-transfer'
        : details.isCrossChain
          ? 'cross-chain-unshield'
          : 'local-unshield',
      destinationChain: details.destinationChainName,
    })

    return details
  } catch (error) {
    onProgress?.({
      stage: 'error',
      message: error instanceof Error ? error.message : 'Send failed',
    })
    throw error
  }
}

/**
 * Validate send parameters before execution
 */
export async function validateSendParams(
  params: SendTransactionParams,
  shieldedBalance: bigint,
): Promise<{ valid: boolean; error?: string }> {
  const { amount, recipientAddress, recipientType, destinationChainKey } = params

  // Validate recipient address
  if (!recipientAddress || recipientAddress.trim() === '') {
    return { valid: false, error: 'Recipient address is required' }
  }

  if (recipientType === 'railgun') {
    if (!recipientAddress.startsWith('0zk')) {
      return { valid: false, error: 'Invalid Railgun address: must start with 0zk' }
    }
  } else if (recipientType === 'ethereum') {
    if (!recipientAddress.startsWith('0x') || recipientAddress.length !== 42) {
      return { valid: false, error: 'Invalid Ethereum address' }
    }
  } else {
    return { valid: false, error: 'Invalid address format' }
  }

  // Validate amount
  const amountRaw = parseUSDC(amount)
  if (amountRaw <= 0n) {
    return { valid: false, error: 'Amount must be greater than 0' }
  }

  // Check balance
  if (amountRaw > shieldedBalance) {
    return { valid: false, error: 'Insufficient shielded balance' }
  }

  // Validate destination chain for unshield
  if (recipientType === 'ethereum') {
    const chainKey = destinationChainKey || 'hub'
    const chain = getChainByKey(chainKey)
    if (!chain) {
      return { valid: false, error: `Unknown destination chain: ${chainKey}` }
    }
  }

  return { valid: true }
}

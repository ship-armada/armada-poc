import type { TrackedTransaction } from '@/types/tx'
import { ensureCorrectNetwork } from '@/services/evm/evmNetworkService'
import { depositForBurn } from '@/services/evm/evmContractService'
import type { DepositTxData } from './txBuilder'
import { logger } from '@/utils/logger'
import { clientStageReporter } from '@/services/flow/clientStageReporter'

export interface DepositTxResult {
  txHash: string
  nonce?: string
}

/**
 * Submits an EVM transaction. For deposit transactions, this handles:
 * - Network verification and switching
 * - USDC approval (if needed)
 * - depositForBurn contract call execution
 * - Transaction receipt waiting
 * - Nonce extraction
 */
export interface SubmitEvmTxOptions {
  onSigningComplete?: () => void
}

export async function submitEvmTx(
  tx: TrackedTransaction,
  options?: SubmitEvmTxOptions
): Promise<string> {
  logger.info('[TxSubmitter] 📤 Submitting EVM transaction', {
    txId: tx.id,
    direction: tx.direction,
    chain: tx.chain,
  })

  if (tx.direction !== 'deposit') {
    throw new Error(`Unsupported transaction direction: ${tx.direction}`)
  }

  // Extract deposit data from transaction
  const depositData = (tx as TrackedTransaction & { depositData?: DepositTxData }).depositData
  if (!depositData) {
    throw new Error('Deposit transaction data not found')
  }

  logger.info('[TxSubmitter] 📋 Deposit transaction data', {
    amount: depositData.amount,
    sourceChain: depositData.sourceChain,
    destinationAddress: depositData.destinationAddress,
    nobleForwardingAddress: depositData.nobleForwardingAddress,
    forwardingAddressBytes32: depositData.forwardingAddressBytes32,
    destinationDomain: depositData.destinationDomain,
  })

  try {
    // Report wallet signing stage
    const flowId = tx.flowMetadata?.localId || tx.id
    await clientStageReporter.reportWalletStage(flowId, 'wallet_signing', 'evm', undefined, 'pending')

    // Ensure we're on the correct network
    logger.info('[TxSubmitter] 🌐 Ensuring correct network...', {
      sourceChain: depositData.sourceChain,
    })
    await ensureCorrectNetwork(depositData.sourceChain)
    logger.info('[TxSubmitter] ✅ Network verified/switched')

    // Report wallet broadcasting stage
    await clientStageReporter.reportWalletStage(flowId, 'wallet_broadcasting', 'evm', undefined, 'pending')

    // Execute depositForBurn (signing happens inside this call when user approves in MetaMask)
    logger.info('[TxSubmitter] 🚀 Executing depositForBurn contract call...', {
      chainKey: depositData.sourceChain,
      amountUsdc: depositData.amount,
      forwardingAddressBytes32: depositData.forwardingAddressBytes32,
      destinationDomain: depositData.destinationDomain,
    })
    const result = await depositForBurn({
      chainKey: depositData.sourceChain,
      amountUsdc: depositData.amount,
      forwardingAddressBytes32: depositData.forwardingAddressBytes32,
      destinationDomain: depositData.destinationDomain,
      onSigningComplete: options?.onSigningComplete,
    })

    // Update signing stage to confirmed (signing is complete after user approves)
    await clientStageReporter.updateStageStatus(flowId, 'wallet_signing', 'confirmed')

    // Update broadcasting stage to confirmed (broadcasting is complete)
    await clientStageReporter.updateStageStatus(flowId, 'wallet_broadcasting', 'confirmed')

    // Report wallet broadcasted stage
    await clientStageReporter.reportWalletStage(flowId, 'wallet_broadcasted', 'evm', result.txHash, 'confirmed')

    logger.info('[TxSubmitter] ✅ Deposit transaction submitted successfully', {
      txHash: result.txHash,
      nonce: result.nonce || 'not extracted',
    })

    return result.txHash
  } catch (error) {
    console.error('[TxSubmitter] Failed to submit deposit transaction', {
      txId: tx.id,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

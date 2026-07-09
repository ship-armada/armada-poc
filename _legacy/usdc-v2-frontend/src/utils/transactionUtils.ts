/**
 * Transaction utility functions for extracting hashes and status information.
 */

import type { StoredTransaction } from '@/services/tx/transactionStorageService'

/**
 * Extract the send transaction hash from a transaction.
 * For deposits: send tx is the EVM transaction hash.
 * For payments: send tx is the Namada transaction hash.
 * 
 * @param transaction - The transaction to extract hash from
 * @returns The send transaction hash, or undefined if not available
 */
export function extractSendTxHash(transaction: StoredTransaction): string | undefined {
  if (!transaction.pollingState) {
    // Fallback to transaction.hash if no polling state
    return transaction.hash
  }

  const { chainStatus } = transaction.pollingState

  if (transaction.direction === 'deposit') {
    // Deposits: Send Tx = evm
    return chainStatus.evm?.metadata?.txHash as string | undefined ||
      chainStatus.evm?.stages?.find(s => s.txHash)?.txHash ||
      transaction.hash
  } else {
    // Payments: Send Tx = namada
    return chainStatus.namada?.metadata?.txHash as string | undefined ||
      chainStatus.namada?.stages?.find(s => s.txHash)?.txHash ||
      transaction.hash
  }
}

/**
 * Extract the receive transaction hash from a transaction.
 * For deposits: receive tx is the Namada transaction hash (after IBC transfer completes).
 * For payments: receive tx is the EVM transaction hash.
 * 
 * @param transaction - The transaction to extract hash from
 * @returns The receive transaction hash, or undefined if not available
 */
export function extractReceiveTxHash(transaction: StoredTransaction): string | undefined {
  if (!transaction.pollingState) {
    return undefined
  }

  const { chainStatus } = transaction.pollingState

  if (transaction.direction === 'deposit') {
    // Deposits: Receive Tx = namadaTxHash from metadata (the transaction hash after IBC transfer completes)
    return transaction.pollingState.metadata?.namadaTxHash as string | undefined ||
      chainStatus.namada?.metadata?.txHash as string | undefined ||
      chainStatus.namada?.stages?.find(s => s.stage === 'namada_received' && s.txHash)?.txHash
  } else {
    // Payments: Receive Tx = evm
    return chainStatus.evm?.metadata?.txHash as string | undefined ||
      chainStatus.evm?.stages?.find(s => s.txHash)?.txHash
  }
}

/**
 * Get the send transaction status.
 * 
 * @param transaction - The transaction
 * @returns 'success' if the send transaction is successful, 'pending' otherwise
 */
export function getSendTxStatus(transaction: StoredTransaction): 'success' | 'pending' {
  if (!transaction.pollingState) return 'pending'
  const chainStatus = transaction.pollingState.chainStatus
  if (transaction.direction === 'deposit') {
    return chainStatus.evm?.status === 'success' ? 'success' : 'pending'
  } else {
    return chainStatus.namada?.status === 'success' ? 'success' : 'pending'
  }
}

/**
 * Get the receive transaction status.
 * 
 * @param transaction - The transaction
 * @returns 'success' if the receive transaction is successful, 'pending' otherwise
 */
export function getReceiveTxStatus(transaction: StoredTransaction): 'success' | 'pending' {
  if (!transaction.pollingState) return 'pending'
  const chainStatus = transaction.pollingState.chainStatus
  if (transaction.direction === 'deposit') {
    return chainStatus.namada?.status === 'success' ? 'success' : 'pending'
  } else {
    return chainStatus.evm?.status === 'success' ? 'success' : 'pending'
  }
}

/**
 * Extract and format transaction amount from transaction metadata.
 * Returns formatted string with "USDC" suffix (e.g., "100.00 USDC").
 * 
 * @param transaction - The transaction to extract amount from
 * @returns Formatted amount string with "USDC" suffix, or undefined if amount not available
 */
export function extractTransactionAmount(transaction: StoredTransaction): string | undefined {
  if (transaction.flowMetadata) {
    const amountInBase = transaction.flowMetadata.amount
    if (amountInBase) {
      const amountInUsdc = (parseInt(amountInBase) / 1_000_000).toFixed(2)
      return `${amountInUsdc} USDC`
    }
  } else if (transaction.depositDetails) {
    return `${transaction.depositDetails.amount} USDC`
  } else if (transaction.paymentDetails) {
    return `${transaction.paymentDetails.amount} USDC`
  }
  return undefined
}


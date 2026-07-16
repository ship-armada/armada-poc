/**
 * Send Fee Estimator Service
 *
 * Stubbed fee estimation for send operations.
 * Can be expanded later with actual gas estimation.
 */

export interface SendFeeEstimate {
  /** Display string for the fee (e.g., "Free (devnet)") */
  networkFee: string
  /** Fee in base units (stubbed as 0n for devnet) */
  networkFeeRaw: bigint
  /** Estimated time for the transaction */
  estimatedTime: string
}

/**
 * Estimate fee for a send transaction
 *
 * Currently stubbed for devnet - returns zero fee.
 *
 * @param recipientType - 'railgun' for private transfer, 'ethereum' for unshield
 * @param destinationChainKey - Destination chain for unshield (e.g., 'hub', 'client-a')
 */
export async function estimateSendFee(
  recipientType: 'railgun' | 'ethereum',
  destinationChainKey?: string,
): Promise<SendFeeEstimate> {
  // Stub implementation for devnet
  const isPrivateTransfer = recipientType === 'railgun'
  const isCrossChain = !isPrivateTransfer && destinationChainKey !== 'hub'

  let estimatedTime: string
  if (isPrivateTransfer) {
    estimatedTime = '~30 seconds'
  } else if (isCrossChain) {
    estimatedTime = '~30 sec + relay'
  } else {
    estimatedTime = '~30 seconds'
  }

  return {
    networkFee: 'Free (devnet)',
    networkFeeRaw: 0n,
    estimatedTime,
  }
}

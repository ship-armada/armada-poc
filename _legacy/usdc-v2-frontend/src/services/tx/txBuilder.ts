import type { TrackedTransaction } from '@/types/tx'
import { logger } from '@/utils/logger'

export interface BuildTxParams {
  amount: string
  sourceChain: string
  destinationChain: string
  recipient: string
  fallback?: string
}

export interface DepositTxData {
  amount: string
  sourceChain: string
  destinationAddress: string
  nobleForwardingAddress: string
  forwardingAddressBytes32: string
  destinationDomain: number
  /** Optional fallback address used when generating Noble forwarding address */
  fallback?: string
  /** Optional: USDC contract address (can be loaded from chain config if missing) */
  usdcAddress?: string
  /** Optional: Message Transmitter contract address (can be loaded from chain config if missing) */
  messageTransmitterAddress?: string
}

/**
 * Builds a deposit transaction.
 *
 * NOTE: Noble chain support has been removed. This function will throw an error.
 * Deposit functionality requires Noble chain integration for CCTP bridging.
 */
export async function buildDepositTx(_params: BuildTxParams): Promise<TrackedTransaction & { depositData?: DepositTxData }> {
  logger.error('[TxBuilder] Deposit functionality disabled - Noble chain support has been removed')
  throw new Error('Deposit functionality requires Noble chain integration, which has been removed from this version.')
}

// Shielding and payment transaction building disabled - Namada Keychain support removed

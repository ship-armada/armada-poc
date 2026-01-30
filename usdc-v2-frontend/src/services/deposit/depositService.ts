/**
 * Deposit service for building, signing, broadcasting, and tracking deposit transactions.
 * NOTE: Deposit functionality requires Noble chain integration which has been removed.
 */

import { buildDepositTx } from '@/services/tx/txBuilder'
import { submitEvmTx, type SubmitEvmTxOptions } from '@/services/tx/txSubmitter'
import { saveItem, loadItem } from '@/services/storage/localStore'
import { logger } from '@/utils/logger'
import { transactionStorageService, type StoredTransaction } from '@/services/tx/transactionStorageService'
import { jotaiStore } from '@/store/jotaiStore'
import { depositFallbackSelectionAtom } from '@/atoms/appAtom'
import type { TrackedTransaction } from '@/types/tx'

export interface DepositParams {
  amount: string
  destinationAddress: string
  sourceChain: string
  fallback?: string // Optional fallback address (if not provided, will be read from atom)
}

export interface DepositTransactionDetails {
  amount: string
  fee: string
  total: string
  destinationAddress: string
  chainName: string
  senderAddress?: string // EVM wallet address that initiated the deposit
  feeBreakdown?: {
    approveNative: string
    burnNative: string
    totalNative: string
    nativeSymbol: string
    approvalNeeded?: boolean
    approveUsd?: number
    burnUsd?: number
    totalUsd?: number
    nobleRegUsd: number
  }
  isLoadingFee?: boolean
}

export interface DepositMetadata {
  txId: string
  txHash?: string
  details: DepositTransactionDetails
  timestamp: number
  status: 'pending' | 'submitted' | 'confirmed' | 'failed'
}

const DEPOSIT_STORAGE_KEY = 'deposit-transactions'

/**
 * Build a deposit transaction.
 * NOTE: Deposit functionality requires Noble chain integration which has been removed.
 *
 * @param params - Deposit parameters
 * @returns Built transaction
 */
export async function buildDepositTransaction(
  params: DepositParams
): Promise<TrackedTransaction> {
  logger.info('[DepositService] Building deposit transaction', {
    amount: params.amount,
    sourceChain: params.sourceChain,
    destinationAddress: params.destinationAddress,
  })

  // Use hardcoded fallback since Tendermint config has been removed
  const destinationChain = 'namada-testnet'

  // Read fallback address from deposit selection atom (if not provided in params)
  const depositFallbackSelection = jotaiStore.get(depositFallbackSelectionAtom)
  const fallback = params.fallback ?? depositFallbackSelection.address ?? undefined

  // Use existing txBuilder service (will throw error since Noble support removed)
  const tx = await buildDepositTx({
    amount: params.amount,
    sourceChain: params.sourceChain,
    destinationChain,
    recipient: params.destinationAddress,
    ...(fallback ? { fallback } : {}),
  })

  logger.info('[DepositService] Deposit transaction built', {
    txId: tx.id,
    chain: tx.chain,
    hasDepositData: !!tx.depositData,
  })

  return tx
}

/**
 * Sign a deposit transaction.
 * Note: Signing is handled automatically by submitEvmTx via MetaMask.
 * This function is kept for API compatibility but just updates the status.
 *
 * @param tx - The transaction to sign
 * @returns Transaction with signing status
 */
export async function signDepositTransaction(
  tx: TrackedTransaction
): Promise<TrackedTransaction> {
  console.debug('[DepositService] Signing deposit transaction', tx.id)

  // Signing is handled in submitEvmTx via MetaMask
  // Just update status for API compatibility
  return {
    ...tx,
    status: 'signing',
  }
}

/**
 * Broadcast a deposit transaction.
 *
 * @param tx - The signed transaction to broadcast
 * @param options - Optional callbacks for phase updates
 * @returns Transaction hash
 */
export async function broadcastDepositTransaction(
  tx: TrackedTransaction,
  options?: SubmitEvmTxOptions
): Promise<string> {
  logger.info('[DepositService] Broadcasting deposit transaction', {
    txId: tx.id,
    chain: tx.chain,
    direction: tx.direction,
  })

  // Use existing txSubmitter service
  const txHash = await submitEvmTx(tx, options)

  logger.info('[DepositService] Deposit transaction broadcasted', {
    txId: tx.id,
    txHash,
  })

  return txHash
}

/**
 * Save deposit transaction to unified storage.
 *
 * @param tx - The transaction to save
 * @param details - Deposit transaction details
 * @returns The saved transaction
 */
export async function saveDepositTransaction(
  tx: TrackedTransaction,
  details: DepositTransactionDetails,
): Promise<StoredTransaction> {
  logger.info('[DepositService] Saving deposit transaction to unified storage', {
    txId: tx.id,
    txHash: tx.hash,
  })

  // Flow metadata should already be in transaction (created during transaction building)
  let flowMetadata = tx.flowMetadata
  // Get existing transaction from storage to preserve clientStages and other fields
  const existingTx = transactionStorageService.getTransaction(tx.id)
  if (!flowMetadata) {
    // Try to get updated transaction from storage
    flowMetadata = existingTx?.flowMetadata
  }

  // Create StoredTransaction with deposit details
  // Preserve clientStages from existing transaction (added during submission)
  // Preserve depositData if it exists on the transaction (from buildDepositTx)
  const txWithDepositData = tx as TrackedTransaction & { depositData?: import('@/services/tx/txBuilder').DepositTxData }
  const storedTx: StoredTransaction = {
    ...tx,
    depositDetails: details,
    depositData: txWithDepositData.depositData,
    flowMetadata,
    clientStages: existingTx?.clientStages, // Preserve client stages added during submission
    updatedAt: Date.now(),
  }

  // Save to unified storage
  transactionStorageService.saveTransaction(storedTx)

  logger.debug('[DepositService] Deposit transaction saved successfully', {
    txId: storedTx.id,
    hasDepositDetails: !!storedTx.depositDetails,
  })

  // Start frontend polling if enabled
  if (storedTx.chain) {
    const { startDepositPolling } = await import('@/services/polling/chainPollingService')
    await startDepositPolling(storedTx.id, storedTx.hash || '', details, storedTx.chain)
  }

  return storedTx
}

/**
 * Save deposit metadata to local storage.
 *
 * @deprecated This function uses legacy storage format. Use saveDepositTransaction() instead.
 * This function creates a separate entry with a different ID system and will be removed.
 *
 * @param txHash - The transaction hash
 * @param details - Deposit transaction details
 */
export async function saveDepositMetadata(
  txHash: string,
  details: DepositTransactionDetails
): Promise<void> {
  const metadata: DepositMetadata = {
    txId: crypto.randomUUID(),
    txHash,
    details,
    timestamp: Date.now(),
    status: 'submitted',
  }

  // Load existing deposits
  const existingDeposits = loadItem<DepositMetadata[]>(DEPOSIT_STORAGE_KEY) ?? []

  // Add new deposit
  const updatedDeposits = [metadata, ...existingDeposits]

  // Save back to storage
  saveItem(DEPOSIT_STORAGE_KEY, updatedDeposits)

  console.debug('[DepositService] Saved deposit metadata (legacy)', metadata)
}


/**
 * Get all saved deposit transactions from local storage.
 *
 * @returns Array of deposit metadata
 */
export function getDepositHistory(): DepositMetadata[] {
  return loadItem<DepositMetadata[]>(DEPOSIT_STORAGE_KEY) ?? []
}

/**
 * Get a specific deposit transaction by hash.
 *
 * @param txHash - The transaction hash
 * @returns Deposit metadata or undefined if not found
 */
export function getDepositByHash(txHash: string): DepositMetadata | undefined {
  const deposits = getDepositHistory()
  return deposits.find((d) => d.txHash === txHash)
}

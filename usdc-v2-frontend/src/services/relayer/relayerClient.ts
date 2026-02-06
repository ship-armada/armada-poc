/**
 * Relayer Client
 *
 * HTTP client for the Armada Relayer API.
 * Handles fee fetching, transaction submission, and status polling.
 */

import { RELAYER_CONFIG } from '@/config/relayer'

// ============ Types ============

export interface FeeSchedule {
  cacheId: string
  expiresAt: number
  chainId: number
  fees: {
    transfer: string
    unshield: string
    crossContract: string
    crossChainShield: string
  }
}

export interface RelayResponse {
  txHash: string
  status: 'pending' | 'confirmed' | 'failed'
}

export interface TransactionStatus {
  status: 'pending' | 'confirmed' | 'failed'
  blockNumber?: number
  error?: string
}

export interface RelayErrorResponse {
  error: string
  code: string
}

// ============ Fee Cache ============

let cachedFees: FeeSchedule | null = null

// ============ Client Functions ============

/**
 * Check if the relayer is enabled
 */
export function isRelayerEnabled(): boolean {
  return RELAYER_CONFIG.enabled
}

/**
 * Get the relayer's Ethereum address (for fee recipient in proofs)
 */
export function getRelayerAddress(): string {
  return RELAYER_CONFIG.relayerAddress
}

/**
 * Fetch the current fee schedule from the relayer
 *
 * Returns cached fees if still valid, otherwise fetches fresh ones.
 */
export async function getFees(): Promise<FeeSchedule> {
  // Return cached if still valid
  if (cachedFees && Date.now() < cachedFees.expiresAt) {
    return cachedFees
  }

  const response = await fetch(`${RELAYER_CONFIG.url}/fees`)
  if (!response.ok) {
    throw new Error(`Failed to fetch relayer fees: ${response.status}`)
  }

  cachedFees = await response.json()
  console.log('[relayer-client] Fetched fee schedule:', cachedFees?.cacheId)
  return cachedFees!
}

/**
 * Get the fee for a specific operation type
 *
 * @returns Fee in USDC raw units (6 decimals)
 */
export async function getRelayerFee(
  operationType: 'transfer' | 'unshield' | 'crossContract' | 'crossChainShield',
): Promise<bigint> {
  const fees = await getFees()
  return BigInt(fees.fees[operationType])
}

/**
 * Submit a populated transaction to the relayer
 *
 * @param to - Target contract address
 * @param data - Encoded calldata
 * @returns Transaction hash
 */
export async function submitTransaction(params: {
  chainId: number
  to: string
  data: string
}): Promise<string> {
  const fees = await getFees()

  console.log('[relayer-client] Submitting transaction to relayer...')
  console.log(`  To: ${params.to}`)
  console.log(`  Data: ${params.data.slice(0, 10)}...`)
  console.log(`  FeesCacheId: ${fees.cacheId}`)

  const response = await fetch(`${RELAYER_CONFIG.url}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: params.chainId,
      to: params.to,
      data: params.data,
      feesCacheId: fees.cacheId,
    }),
  })

  if (!response.ok) {
    const errorBody = (await response.json()) as RelayErrorResponse
    throw new Error(`Relay failed (${errorBody.code}): ${errorBody.error}`)
  }

  const result = (await response.json()) as RelayResponse
  console.log('[relayer-client] Transaction submitted:', result.txHash)
  return result.txHash
}

/**
 * Check the status of a relayed transaction
 */
export async function getTransactionStatus(txHash: string): Promise<TransactionStatus> {
  const response = await fetch(`${RELAYER_CONFIG.url}/status/${txHash}`)
  if (!response.ok) {
    throw new Error(`Failed to check status: ${response.status}`)
  }
  return response.json()
}

/**
 * Submit a transaction and wait for confirmation
 *
 * Polls the relayer's /status endpoint until the transaction is confirmed or fails.
 *
 * @returns Transaction hash
 */
export async function submitAndWaitForConfirmation(params: {
  chainId: number
  to: string
  data: string
}): Promise<string> {
  const txHash = await submitTransaction(params)

  console.log('[relayer-client] Waiting for confirmation...')

  const startTime = Date.now()

  while (Date.now() - startTime < RELAYER_CONFIG.confirmationTimeoutMs) {
    const status = await getTransactionStatus(txHash)

    if (status.status === 'confirmed') {
      console.log(
        `[relayer-client] Transaction confirmed in block ${status.blockNumber}`,
      )
      return txHash
    }

    if (status.status === 'failed') {
      throw new Error(`Transaction failed: ${status.error || 'unknown error'}`)
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, RELAYER_CONFIG.statusPollIntervalMs))
  }

  throw new Error('Transaction confirmation timed out')
}

/**
 * Check if the relayer is reachable
 */
export async function checkRelayerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${RELAYER_CONFIG.url}/`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

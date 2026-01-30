/**
 * Shield Fee Estimator Service (Stub)
 *
 * Provides gas fee estimates for shield transactions.
 *
 * STUB NOTE: Currently returns hardcoded estimates. Real implementation
 * would use eth_estimateGas for accurate gas simulation.
 */

import { ethers } from 'ethers'
import { loadDeployments, getHubChain } from '@/config/deployments'
import { getShieldAllowance } from './shieldContractService'

// ============ Types ============

export interface ShieldFeeEstimate {
  /** Estimated gas for approval (0 if not needed) */
  approveGas: bigint
  /** Estimated gas for shield transaction */
  shieldGas: bigint
  /** Total estimated gas */
  totalGas: bigint
  /** Current gas price in wei */
  gasPriceWei: bigint
  /** Total fee in native token (formatted) */
  totalNative: string
  /** Native token symbol */
  nativeSymbol: string
  /** Total fee in USD (stub: undefined) */
  totalUsd?: number
  /** Whether approval is needed */
  approvalNeeded: boolean
}

// ============ Constants (Stub Values) ============

// Conservative gas estimates based on observed transactions
const APPROVE_GAS_ESTIMATE = 50_000n
const SHIELD_GAS_ESTIMATE = 500_000n // Shield is expensive due to ZK operations

// ============ Functions ============

/**
 * Estimate fees for a shield transaction
 *
 * STUB: Returns hardcoded gas estimates. Real implementation would
 * use eth_estimateGas with actual transaction data.
 */
export async function estimateShieldFee(
  ownerAddress: string,
  amount: bigint,
): Promise<ShieldFeeEstimate> {
  await loadDeployments()
  const hubChain = getHubChain()

  // Check if approval is needed
  const allowance = await getShieldAllowance(ownerAddress)
  const approvalNeeded = allowance < amount

  // Calculate gas estimates
  const approveGas = approvalNeeded ? APPROVE_GAS_ESTIMATE : 0n
  const shieldGas = SHIELD_GAS_ESTIMATE
  const totalGas = approveGas + shieldGas

  // Get current gas price
  let gasPriceWei = 1_000_000_000n // Default 1 gwei for local devnet
  try {
    const provider = new ethers.JsonRpcProvider(hubChain.rpcUrl)
    const feeData = await provider.getFeeData()
    gasPriceWei = feeData.gasPrice ?? gasPriceWei
  } catch (error) {
    console.warn('[shield-fee] Failed to get gas price, using default:', error)
  }

  // Calculate total fee in wei
  const totalFeeWei = totalGas * gasPriceWei

  // Format as native token amount
  const totalNative = ethers.formatEther(totalFeeWei)

  // STUB: USD conversion not implemented
  // Real implementation would fetch price from oracle or API
  const totalUsd = undefined

  return {
    approveGas,
    shieldGas,
    totalGas,
    gasPriceWei,
    totalNative: `${parseFloat(totalNative).toFixed(6)} ETH`,
    nativeSymbol: 'ETH',
    totalUsd,
    approvalNeeded,
  }
}

/**
 * Format fee estimate for display
 */
export function formatFeeEstimate(estimate: ShieldFeeEstimate): string {
  if (estimate.totalUsd !== undefined) {
    return `${estimate.totalNative} (~$${estimate.totalUsd.toFixed(2)})`
  }
  return estimate.totalNative
}

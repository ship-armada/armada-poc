/**
 * Yield Service
 *
 * Handles lend and redeem operations with the ArmadaYieldAdapter.
 * Converts between shielded USDC and shielded ayUSDC (yield-bearing shares).
 *
 * Shielded operations (executeShieldedLend, executeShieldedRedeem) - trustless via adaptContract
 */

import { ethers } from 'ethers'
import { loadDeployments, getYieldDeployment } from '@/config/deployments'

// Re-export shielded yield operations
export {
  executeShieldedLend,
  executeShieldedRedeem,
  validateShieldedLendParams,
  validateShieldedRedeemParams,
  type ShieldedYieldProgress,
  type ShieldedYieldStage,
  type ShieldedLendParams,
  type ShieldedRedeemParams,
  type ShieldedYieldResult,
} from './shieldedYieldService'

// ABI for ArmadaYieldAdapter (preview functions only)
const ADAPTER_ABI = [
  'function previewLend(uint256 amount) external view returns (uint256)',
  'function previewRedeem(uint256 shares) external view returns (uint256)',
]

// ABI for Aave Spoke (to get APY)
const AAVE_SPOKE_ABI = [
  'function reserves(uint256 reserveId) view returns (address underlying, uint256 totalShares, uint256 totalDeposited, uint256 liquidityIndex, uint256 lastUpdateTimestamp, uint256 annualYieldBps, bool mintableYield)',
]

// ============ Helper Functions ============

function parseUSDC(amount: string): bigint {
  return ethers.parseUnits(amount, 6)
}

function formatUSDC(amount: bigint): string {
  return ethers.formatUnits(amount, 6)
}

// ============ Service Functions ============

/**
 * Preview lend - get expected shares for USDC amount
 */
export async function previewLend(amount: string): Promise<string> {
  await loadDeployments()
  const yieldDeployment = getYieldDeployment()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const provider = new ethers.JsonRpcProvider('http://localhost:8545')
  const adapter = new ethers.Contract(
    yieldDeployment.contracts.armadaYieldAdapter,
    ADAPTER_ABI,
    provider,
  )

  const amountRaw = parseUSDC(amount)
  const sharesRaw = await adapter.previewLend(amountRaw)
  return formatUSDC(sharesRaw)
}

/**
 * Preview redeem - get expected USDC for shares amount
 */
export async function previewRedeem(shares: string): Promise<string> {
  await loadDeployments()
  const yieldDeployment = getYieldDeployment()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const provider = new ethers.JsonRpcProvider('http://localhost:8545')
  const adapter = new ethers.Contract(
    yieldDeployment.contracts.armadaYieldAdapter,
    ADAPTER_ABI,
    provider,
  )

  const sharesRaw = parseUSDC(shares)
  const assetsRaw = await adapter.previewRedeem(sharesRaw)
  return formatUSDC(assetsRaw)
}

/**
 * Get current APY from Aave Spoke
 * @returns APY as a percentage (e.g., 5.0 for 5%)
 */
export async function getCurrentAPY(): Promise<number> {
  await loadDeployments()
  const yieldDeployment = getYieldDeployment()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const provider = new ethers.JsonRpcProvider('http://localhost:8545')
  const aaveSpoke = new ethers.Contract(
    yieldDeployment.config.mockAaveSpoke,
    AAVE_SPOKE_ABI,
    provider,
  )

  const reserveInfo = await aaveSpoke.reserves(yieldDeployment.config.reserveId)
  // annualYieldBps is in basis points (e.g., 500 = 5%)
  return Number(reserveInfo.annualYieldBps) / 100
}

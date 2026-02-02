/**
 * Yield Service
 *
 * Handles lend and redeem operations with the ArmadaYieldAdapter.
 * Converts between shielded USDC and shielded ayUSDC (yield-bearing shares).
 *
 * Two modes:
 * 1. Public wallet operations (lend, redeemShares) - for debugging
 * 2. Shielded operations (executeShieldedLend, executeShieldedRedeem) - trustless via adaptContract
 */

import { ethers } from 'ethers'
import { loadDeployments, getYieldDeployment, getHubChain } from '@/config/deployments'

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

// ABI for ArmadaYieldAdapter
const ADAPTER_ABI = [
  'function lend(uint256 amount) external returns (uint256 shares)',
  'function redeemShares(uint256 shares) external returns (uint256 assets)',
  'function previewLend(uint256 amount) external view returns (uint256)',
  'function previewRedeem(uint256 shares) external view returns (uint256)',
  'event Lend(address indexed user, uint256 usdcAmount, uint256 sharesMinted)',
  'event Redeem(address indexed user, uint256 sharesBurned, uint256 usdcRedeemed)',
]

// ABI for USDC approval
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]

// ABI for Aave Spoke (to get APY)
const AAVE_SPOKE_ABI = [
  'function reserves(uint256 reserveId) view returns (address underlying, uint256 totalShares, uint256 totalDeposited, uint256 liquidityIndex, uint256 lastUpdateTimestamp, uint256 annualYieldBps, bool mintableYield)',
]

// ============ Types ============

export type YieldStage =
  | 'preparing'
  | 'approving'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'error'

export interface YieldProgress {
  stage: YieldStage
  message: string
}

export interface LendParams {
  /** Amount in human readable format (e.g., "100.50") */
  amount: string
}

export interface RedeemParams {
  /** Shares in human readable format (e.g., "100.50") */
  shares: string
}

export interface YieldTransactionDetails {
  txHash: string
  usdcAmount: string
  sharesAmount: string
  type: 'lend' | 'redeem'
}

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

/**
 * Execute lend transaction - deposit USDC to receive ayUSDC shares
 */
export async function executeLendTransaction(
  params: LendParams,
  signer: ethers.Signer,
  onProgress?: (progress: YieldProgress) => void,
): Promise<YieldTransactionDetails> {
  await loadDeployments()
  const yieldDeployment = getYieldDeployment()
  const hubChain = getHubChain()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter
  const usdcAddress = hubChain.contracts?.mockUSDC

  if (!usdcAddress) {
    throw new Error('USDC address not found')
  }

  const amountRaw = parseUSDC(params.amount)

  // 1. Check/perform approval
  onProgress?.({ stage: 'preparing', message: 'Checking USDC approval...' })

  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer)
  const signerAddress = await signer.getAddress()
  const currentAllowance = await usdc.allowance(signerAddress, adapterAddress)

  if (currentAllowance < amountRaw) {
    onProgress?.({ stage: 'approving', message: 'Approving USDC...' })
    const approveTx = await usdc.approve(adapterAddress, amountRaw)
    await approveTx.wait()
  }

  // 2. Execute lend
  onProgress?.({ stage: 'signing', message: 'Please sign the lend transaction...' })

  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer)
  const tx = await adapter.lend(amountRaw)

  onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })

  const receipt = await tx.wait()

  // Parse event to get shares minted
  const lendEvent = receipt.logs.find(
    (log: any) => log.fragment?.name === 'Lend',
  )

  let sharesMinted = amountRaw // Default to 1:1 if event parsing fails
  if (lendEvent && lendEvent.args) {
    sharesMinted = lendEvent.args.sharesMinted
  }

  onProgress?.({ stage: 'success', message: 'Lend successful!' })

  return {
    txHash: receipt.hash,
    usdcAmount: params.amount,
    sharesAmount: formatUSDC(sharesMinted),
    type: 'lend',
  }
}

/**
 * Execute redeem transaction - redeem ayUSDC shares for USDC
 */
export async function executeRedeemTransaction(
  params: RedeemParams,
  signer: ethers.Signer,
  onProgress?: (progress: YieldProgress) => void,
): Promise<YieldTransactionDetails> {
  await loadDeployments()
  const yieldDeployment = getYieldDeployment()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter
  const vaultAddress = yieldDeployment.contracts.armadaYieldVault
  const sharesRaw = parseUSDC(params.shares)

  // 1. Check/perform approval for vault shares
  onProgress?.({ stage: 'preparing', message: 'Checking ayUSDC approval...' })

  const vault = new ethers.Contract(vaultAddress, ERC20_ABI, signer)
  const signerAddress = await signer.getAddress()
  const currentAllowance = await vault.allowance(signerAddress, adapterAddress)

  if (currentAllowance < sharesRaw) {
    onProgress?.({ stage: 'approving', message: 'Approving ayUSDC...' })
    const approveTx = await vault.approve(adapterAddress, sharesRaw)
    await approveTx.wait()
  }

  // 2. Execute redeem
  onProgress?.({ stage: 'signing', message: 'Please sign the redeem transaction...' })

  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer)
  const tx = await adapter.redeemShares(sharesRaw)

  onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })

  const receipt = await tx.wait()

  // Parse event to get USDC redeemed
  const redeemEvent = receipt.logs.find(
    (log: any) => log.fragment?.name === 'Redeem',
  )

  let usdcRedeemed = sharesRaw // Default to 1:1 if event parsing fails
  if (redeemEvent && redeemEvent.args) {
    usdcRedeemed = redeemEvent.args.usdcRedeemed
  }

  onProgress?.({ stage: 'success', message: 'Redeem successful!' })

  return {
    txHash: receipt.hash,
    usdcAmount: formatUSDC(usdcRedeemed),
    sharesAmount: params.shares,
    type: 'redeem',
  }
}

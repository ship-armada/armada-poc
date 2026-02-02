/**
 * Shielded Yield Service
 *
 * Handles trustless shielded lend and redeem operations using Railgun's
 * cross-contract calls pattern with real proof verification.
 *
 * Flow:
 * - Lend: Shielded USDC -> Unshield to RelayAdapt -> Deposit to Vault -> Shield ayUSDC
 * - Redeem: Shielded ayUSDC -> Unshield to RelayAdapt -> Redeem from Vault -> Shield USDC
 *
 * Trust Model:
 * - Uses Railgun's RelayAdapt contract which the SDK natively supports
 * - Proof includes adaptContract (RelayAdapt) and adaptParams (hash of calls + shield recipients)
 * - Cross-contract calls are executed atomically with proper proof verification
 * - NO post-proof modifications - proof commits to all parameters
 */

import { ethers } from 'ethers'
import type { ContractTransaction } from 'ethers'
import {
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from '@railgun-community/wallet'
import {
  TXIDVersion,
  EVMGasType,
  NetworkName,
  type RailgunERC20Amount,
  type RailgunERC20Recipient,
  type TransactionGasDetails,
} from '@railgun-community/shared-models'
import { loadHubNetwork, isHubNetworkLoaded, getHubChainConfig } from '@/lib/railgun/network'
import { initializeProver, isProverReady } from '@/lib/railgun/prover'
import { loadDeployments, getYieldDeployment, getHubChain } from '@/config/deployments'
import { parseUSDC } from '@/lib/sdk'

// ============ Types ============

export type ShieldedYieldStage =
  | 'preparing'
  | 'init-prover'
  | 'generating-proof'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'error'

export interface ShieldedYieldProgress {
  stage: ShieldedYieldStage
  message: string
  proofProgress?: number
}

export interface ShieldedLendParams {
  /** Amount in human readable format (e.g., "100.50") */
  amount: string
  /** User's Railgun address for re-shielding ayUSDC */
  railgunAddress: string
}

export interface ShieldedRedeemParams {
  /** Shares in human readable format (e.g., "100.50") */
  shares: string
  /** User's Railgun address for re-shielding USDC */
  railgunAddress: string
}

export interface ShieldedYieldResult {
  txHash: string
  inputAmount: string
  outputAmount: string
  type: 'lend' | 'redeem'
}

// ============ ABI Definitions ============

// Vault ABI for deposit/redeem calls
const VAULT_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
]

// ERC20 ABI for approvals
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
]

// ============ Helper Functions ============

/**
 * Build cross-contract calls for vault deposit
 * These calls will be executed by RelayAdapt after unshielding USDC
 */
function buildDepositCalls(
  usdcAddress: string,
  vaultAddress: string,
  relayAdaptAddress: string,
  amount: bigint,
): ContractTransaction[] {
  const vault = new ethers.Interface(VAULT_ABI)
  const erc20 = new ethers.Interface(ERC20_ABI)

  // 1. Approve vault to spend USDC
  const approveData = erc20.encodeFunctionData('approve', [vaultAddress, amount])

  // 2. Deposit USDC to vault, shares go to RelayAdapt (which will shield them)
  const depositData = vault.encodeFunctionData('deposit', [amount, relayAdaptAddress])

  return [
    {
      to: usdcAddress,
      data: approveData,
      value: 0n,
    } as unknown as ContractTransaction,
    {
      to: vaultAddress,
      data: depositData,
      value: 0n,
    } as unknown as ContractTransaction,
  ]
}

/**
 * Build cross-contract calls for vault redeem
 * These calls will be executed by RelayAdapt after unshielding ayUSDC
 */
function buildRedeemCalls(
  vaultAddress: string,
  relayAdaptAddress: string,
  shares: bigint,
): ContractTransaction[] {
  const vault = new ethers.Interface(VAULT_ABI)
  const erc20 = new ethers.Interface(ERC20_ABI)

  // 1. Approve vault to burn shares (not strictly needed for redeem but good practice)
  const approveData = erc20.encodeFunctionData('approve', [vaultAddress, shares])

  // 2. Redeem shares from vault, USDC goes to RelayAdapt (which will shield it)
  const redeemData = vault.encodeFunctionData('redeem', [shares, relayAdaptAddress, relayAdaptAddress])

  return [
    {
      to: vaultAddress,
      data: approveData,
      value: 0n,
    } as unknown as ContractTransaction,
    {
      to: vaultAddress,
      data: redeemData,
      value: 0n,
    } as unknown as ContractTransaction,
  ]
}

// ============ Main Functions ============

/**
 * Execute shielded lend: Shielded USDC -> Shielded ayUSDC
 *
 * Uses Railgun's cross-contract calls pattern:
 * 1. Unshield USDC to RelayAdapt
 * 2. RelayAdapt executes: approve + deposit to vault
 * 3. RelayAdapt shields ayUSDC back to user
 *
 * Proof verifies the entire flow atomically with real SNARK verification.
 */
export async function executeShieldedLend(
  params: ShieldedLendParams,
  walletId: string,
  encryptionKey: string,
  onProgress?: (progress: ShieldedYieldProgress) => void,
): Promise<ShieldedYieldResult> {
  const { amount, railgunAddress } = params

  console.log('[shielded-yield] Starting shielded lend with cross-contract calls...')
  console.log('[shielded-yield]   Amount:', amount)
  console.log('[shielded-yield]   Railgun Address:', railgunAddress.slice(0, 30) + '...')

  // Load deployments
  onProgress?.({ stage: 'preparing', message: 'Loading configuration...' })
  await loadDeployments()

  const yieldDeployment = getYieldDeployment()
  const hubChain = getHubChain()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const vaultAddress = yieldDeployment.contracts.armadaYieldVault
  const usdcAddress = hubChain.contracts?.mockUSDC
  if (!usdcAddress) {
    throw new Error('USDC address not found')
  }

  // Get RelayAdapt address from network config
  const hubConfig = getHubChainConfig()
  const relayAdaptAddress = hubConfig.relayAdaptContract
  if (!relayAdaptAddress) {
    throw new Error('RelayAdapt contract not configured for this network')
  }

  const amountRaw = parseUSDC(amount)

  // Step 1: Initialize prover if needed
  if (!isProverReady()) {
    onProgress?.({ stage: 'init-prover', message: 'Initializing prover...' })
    await initializeProver()
  }

  // Ensure network is loaded
  if (!isHubNetworkLoaded()) {
    await loadHubNetwork()
  }

  // Step 2: Build cross-contract calls for deposit
  const crossContractCalls = buildDepositCalls(
    usdcAddress,
    vaultAddress,
    relayAdaptAddress,
    amountRaw,
  )

  // Step 3: Define unshield amounts (USDC to unshield)
  const relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[] = [
    {
      tokenAddress: usdcAddress,
      amount: amountRaw,
    },
  ]

  // Step 4: Define shield recipients (ayUSDC back to user)
  // For now, we shield the same amount - actual shares may differ slightly
  const relayAdaptShieldERC20Recipients: RailgunERC20Recipient[] = [
    {
      tokenAddress: vaultAddress, // ayUSDC is the vault token
      recipientAddress: railgunAddress,
    },
  ]

  // Step 5: Generate cross-contract calls proof
  onProgress?.({
    stage: 'generating-proof',
    message: 'Generating zero-knowledge proof...',
    proofProgress: 0,
  })

  const networkName = 'Hardhat' as NetworkName

  await generateCrossContractCallsProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    relayAdaptUnshieldERC20Amounts,
    [], // No NFTs
    relayAdaptShieldERC20Recipients,
    [], // No NFT recipients
    crossContractCalls,
    undefined, // No broadcaster fee
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    undefined, // minGasLimit
    (progress) => {
      console.log(`[shielded-yield] Proof progress: ${Math.round(progress)}%`)
      onProgress?.({
        stage: 'generating-proof',
        message: `Generating proof... ${Math.round(progress)}%`,
        proofProgress: progress / 100,
      })
    },
  )

  console.log('[shielded-yield] Proof generated, populating transaction...')

  // Step 6: Populate transaction
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 5000000n, // Higher for cross-contract calls
    maxFeePerGas: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
  }

  const populateResult = await populateProvedCrossContractCalls(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    relayAdaptUnshieldERC20Amounts,
    [],
    relayAdaptShieldERC20Recipients,
    [],
    crossContractCalls,
    undefined,
    true,
    undefined,
    gasDetails,
  )

  // Debug: Log transaction details
  console.log('[shielded-yield] Transaction target (to):', populateResult.transaction.to)
  console.log('[shielded-yield] Expected RelayAdapt:', relayAdaptAddress)
  console.log('[shielded-yield] Cross-contract calls:', crossContractCalls.length)
  crossContractCalls.forEach((call, i) => {
    console.log(`[shielded-yield]   Call ${i}: to=${call.to}, data=${(call.data as string).slice(0, 10)}...`)
  })

  // Step 7: Get signer and submit
  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  onProgress?.({ stage: 'signing', message: 'Please sign the transaction...' })

  const txRequest = {
    to: populateResult.transaction.to,
    data: populateResult.transaction.data,
    value: populateResult.transaction.value ?? 0n,
    gasLimit: gasDetails.gasEstimate,
  }

  const tx = await signer.sendTransaction(txRequest)
  console.log('[shielded-yield] Transaction submitted:', tx.hash)

  onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })

  const receipt = await tx.wait()
  if (!receipt || receipt.status === 0) {
    throw new Error('Shielded lend transaction failed')
  }

  onProgress?.({ stage: 'success', message: 'Shielded lend complete!' })

  console.log('[shielded-yield] Shielded lend complete:', {
    txHash: receipt.hash,
    usdcDeposited: amount,
  })

  return {
    txHash: receipt.hash,
    inputAmount: amount,
    outputAmount: amount, // Approximate - actual shares may differ
    type: 'lend',
  }
}

/**
 * Execute shielded redeem: Shielded ayUSDC -> Shielded USDC
 *
 * Uses Railgun's cross-contract calls pattern - same approach as lend but reversed.
 */
export async function executeShieldedRedeem(
  params: ShieldedRedeemParams,
  walletId: string,
  encryptionKey: string,
  onProgress?: (progress: ShieldedYieldProgress) => void,
): Promise<ShieldedYieldResult> {
  const { shares, railgunAddress } = params

  console.log('[shielded-yield] Starting shielded redeem with cross-contract calls...')
  console.log('[shielded-yield]   Shares:', shares)
  console.log('[shielded-yield]   Railgun Address:', railgunAddress.slice(0, 30) + '...')

  // Load deployments
  onProgress?.({ stage: 'preparing', message: 'Loading configuration...' })
  await loadDeployments()

  const yieldDeployment = getYieldDeployment()
  const hubChain = getHubChain()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const vaultAddress = yieldDeployment.contracts.armadaYieldVault
  const usdcAddress = hubChain.contracts?.mockUSDC
  if (!usdcAddress) {
    throw new Error('USDC address not found')
  }

  // Get RelayAdapt address from network config
  const hubConfig = getHubChainConfig()
  const relayAdaptAddress = hubConfig.relayAdaptContract
  if (!relayAdaptAddress) {
    throw new Error('RelayAdapt contract not configured for this network')
  }

  const sharesRaw = parseUSDC(shares)

  // Step 1: Initialize prover if needed
  if (!isProverReady()) {
    onProgress?.({ stage: 'init-prover', message: 'Initializing prover...' })
    await initializeProver()
  }

  // Ensure network is loaded
  if (!isHubNetworkLoaded()) {
    await loadHubNetwork()
  }

  // Step 2: Build cross-contract calls for redeem
  const crossContractCalls = buildRedeemCalls(
    vaultAddress,
    relayAdaptAddress,
    sharesRaw,
  )

  // Step 3: Define unshield amounts (ayUSDC shares to unshield)
  const relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[] = [
    {
      tokenAddress: vaultAddress, // ayUSDC
      amount: sharesRaw,
    },
  ]

  // Step 4: Define shield recipients (USDC back to user)
  const relayAdaptShieldERC20Recipients: RailgunERC20Recipient[] = [
    {
      tokenAddress: usdcAddress,
      recipientAddress: railgunAddress,
    },
  ]

  // Step 5: Generate cross-contract calls proof
  onProgress?.({
    stage: 'generating-proof',
    message: 'Generating zero-knowledge proof...',
    proofProgress: 0,
  })

  const networkName = 'Hardhat' as NetworkName

  await generateCrossContractCallsProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    relayAdaptUnshieldERC20Amounts,
    [],
    relayAdaptShieldERC20Recipients,
    [],
    crossContractCalls,
    undefined,
    true,
    undefined,
    undefined,
    (progress) => {
      console.log(`[shielded-yield] Proof progress: ${Math.round(progress)}%`)
      onProgress?.({
        stage: 'generating-proof',
        message: `Generating proof... ${Math.round(progress)}%`,
        proofProgress: progress / 100,
      })
    },
  )

  console.log('[shielded-yield] Proof generated, populating transaction...')

  // Step 6: Populate transaction
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 5000000n,
    maxFeePerGas: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
  }

  const populateResult = await populateProvedCrossContractCalls(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    relayAdaptUnshieldERC20Amounts,
    [],
    relayAdaptShieldERC20Recipients,
    [],
    crossContractCalls,
    undefined,
    true,
    undefined,
    gasDetails,
  )

  // Debug: Log transaction details
  console.log('[shielded-yield] Redeem transaction target (to):', populateResult.transaction.to)
  console.log('[shielded-yield] Expected RelayAdapt:', relayAdaptAddress)
  console.log('[shielded-yield] Cross-contract calls:', crossContractCalls.length)
  crossContractCalls.forEach((call, i) => {
    console.log(`[shielded-yield]   Call ${i}: to=${call.to}, data=${(call.data as string).slice(0, 10)}...`)
  })

  // Step 7: Get signer and submit
  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  onProgress?.({ stage: 'signing', message: 'Please sign the transaction...' })

  const txRequest = {
    to: populateResult.transaction.to,
    data: populateResult.transaction.data,
    value: populateResult.transaction.value ?? 0n,
    gasLimit: gasDetails.gasEstimate,
  }

  const tx = await signer.sendTransaction(txRequest)
  console.log('[shielded-yield] Transaction submitted:', tx.hash)

  onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })

  const receipt = await tx.wait()
  if (!receipt || receipt.status === 0) {
    throw new Error('Shielded redeem transaction failed')
  }

  onProgress?.({ stage: 'success', message: 'Shielded redeem complete!' })

  console.log('[shielded-yield] Shielded redeem complete:', {
    txHash: receipt.hash,
    sharesRedeemed: shares,
  })

  return {
    txHash: receipt.hash,
    inputAmount: shares,
    outputAmount: shares, // Approximate - actual USDC may differ
    type: 'redeem',
  }
}

/**
 * Validate shielded lend parameters
 */
export async function validateShieldedLendParams(
  params: ShieldedLendParams,
  shieldedUsdcBalance: bigint,
): Promise<{ valid: boolean; error?: string }> {
  const { amount, railgunAddress } = params

  if (!railgunAddress || !railgunAddress.startsWith('0zk')) {
    return { valid: false, error: 'Invalid Railgun address' }
  }

  const amountRaw = parseUSDC(amount)
  if (amountRaw <= 0n) {
    return { valid: false, error: 'Amount must be greater than 0' }
  }

  if (amountRaw > shieldedUsdcBalance) {
    return { valid: false, error: 'Insufficient shielded USDC balance' }
  }

  return { valid: true }
}

/**
 * Validate shielded redeem parameters
 */
export async function validateShieldedRedeemParams(
  params: ShieldedRedeemParams,
  shieldedSharesBalance: bigint,
): Promise<{ valid: boolean; error?: string }> {
  const { shares, railgunAddress } = params

  if (!railgunAddress || !railgunAddress.startsWith('0zk')) {
    return { valid: false, error: 'Invalid Railgun address' }
  }

  const sharesRaw = parseUSDC(shares)
  if (sharesRaw <= 0n) {
    return { valid: false, error: 'Shares must be greater than 0' }
  }

  if (sharesRaw > shieldedSharesBalance) {
    return { valid: false, error: 'Insufficient shielded ayUSDC balance' }
  }

  return { valid: true }
}

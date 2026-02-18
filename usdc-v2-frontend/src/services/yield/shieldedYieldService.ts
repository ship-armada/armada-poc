/**
 * Shielded Yield Service
 *
 * Handles trustless shielded lend and redeem operations via ArmadaYieldAdapter.
 *
 * Flow:
 * - Lend: Shielded USDC -> Unshield to Adapter -> Deposit to Vault -> Shield ayUSDC
 * - Redeem: Shielded ayUSDC -> Unshield to Adapter -> Redeem from Vault -> Shield USDC
 *
 * Trust Model (see docs/RELAYER_SPEC.md):
 * - adaptContract (ArmadaYieldAdapter) + adaptParams (YieldAdaptParams) bind the re-shield destination
 * - Proof commits to npk, encryptedBundle, shieldKey - adapter cannot deviate
 * - Relayer pays gas, may charge fee; cannot steal funds (proof commits to outputs)
 */

import {
  generateYieldAdaptLendProof,
  generateYieldAdaptRedeemProof,
} from '@/lib/yieldAdaptProof'
import { loadHubNetwork, isHubNetworkLoaded } from '@/lib/railgun/network'
import { initializeProver, isProverReady } from '@/lib/railgun/prover'
import { loadDeployments, getYieldDeployment, getHubChain } from '@/config/deployments'
import { parseUSDC } from '@/lib/sdk'
import {
  isRelayerEnabled,
  getRelayerRailgunAddress,
  getRelayerFee,
  submitAndWaitForConfirmation,
} from '@/services/relayer'

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

// ============ Main Functions ============

const GAS_ESTIMATE = 5000000n

/**
 * Execute shielded lend: Shielded USDC -> Shielded ayUSDC
 *
 * Uses ArmadaYieldAdapter.lendAndShield - trustless via adaptParams binding.
 */
export async function executeShieldedLend(
  params: ShieldedLendParams,
  walletId: string,
  encryptionKey: string,
  onProgress?: (progress: ShieldedYieldProgress) => void,
): Promise<ShieldedYieldResult> {
  const { amount, railgunAddress } = params

  console.log('[shielded-yield] Starting shielded lend via ArmadaYieldAdapter...')
  console.log('[shielded-yield]   Amount:', amount)
  console.log('[shielded-yield]   Railgun Address:', railgunAddress.slice(0, 30) + '...')

  onProgress?.({ stage: 'preparing', message: 'Loading configuration...' })
  await loadDeployments()

  const yieldDeployment = getYieldDeployment()
  const hubChain = getHubChain()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter
  const vaultAddress = yieldDeployment.contracts.armadaYieldVault
  const usdcAddress = hubChain.contracts?.mockUSDC
  if (!usdcAddress) {
    throw new Error('USDC address not found')
  }

  const amountRaw = parseUSDC(amount)

  if (!isProverReady()) {
    onProgress?.({ stage: 'init-prover', message: 'Initializing prover...' })
    await initializeProver()
  }

  if (!isHubNetworkLoaded()) {
    await loadHubNetwork()
  }

  const useRelayer = isRelayerEnabled()
  let broadcasterFeeRecipient:
    | { tokenAddress: string; amount: bigint; recipientAddress: string }
    | undefined
  if (useRelayer) {
    const fee = await getRelayerFee('crossContract')
    const relayerRailgunAddr = getRelayerRailgunAddress()
    if (relayerRailgunAddr?.startsWith('0zk')) {
      broadcasterFeeRecipient = {
        tokenAddress: usdcAddress,
        amount: fee,
        recipientAddress: relayerRailgunAddr,
      }
      console.log(`[shielded-yield] Including relayer fee: ${fee.toString()} raw USDC`)
    } else {
      console.warn(
        '[shielded-yield] Relayer enabled but relayerRailgunAddress not configured. ' +
          'Fee omitted from proof. Add relayerRailgunAddress (0zk...) to relayer config for fee collection.',
      )
    }
  }

  onProgress?.({
    stage: 'generating-proof',
    message: 'Generating zero-knowledge proof...',
    proofProgress: 0,
  })

  const proofResult = await generateYieldAdaptLendProof({
    walletId,
    encryptionKey,
    amount: amountRaw,
    railgunAddress,
    adapterAddress,
    usdcAddress,
    vaultAddress,
    broadcasterFeeRecipient,
    sendWithPublicWallet: !useRelayer,
    progressCallback: (progress) => {
      console.log(`[shielded-yield] Proof progress: ${Math.round(progress)}%`)
      onProgress?.({
        stage: 'generating-proof',
        message: `Generating proof... ${Math.round(progress)}%`,
        proofProgress: progress / 100,
      })
    },
  })

  console.log('[shielded-yield] Proof generated, submitting transaction...')

  const { transaction } = proofResult

  if (useRelayer) {
    onProgress?.({ stage: 'confirming', message: 'Submitting to relayer...' })
    const txHash = await submitAndWaitForConfirmation({
      chainId: 31337,
      to: transaction.to,
      data: transaction.data,
    })

    onProgress?.({ stage: 'success', message: 'Shielded lend complete!' })
    console.log('[shielded-yield] Shielded lend confirmed via relayer:', txHash)

    return {
      txHash,
      inputAmount: amount,
      outputAmount: amount,
      type: 'lend',
    }
  }

  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const { ethers } = await import('ethers')
  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  onProgress?.({ stage: 'signing', message: 'Please sign the transaction...' })

  const tx = await signer.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    gasLimit: GAS_ESTIMATE,
  })
  console.log('[shielded-yield] Transaction submitted:', tx.hash)

  onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })

  const receipt = await tx.wait()
  if (!receipt || receipt.status === 0) {
    throw new Error('Shielded lend transaction failed')
  }

  onProgress?.({ stage: 'success', message: 'Shielded lend complete!' })

  return {
    txHash: receipt.hash,
    inputAmount: amount,
    outputAmount: amount,
    type: 'lend',
  }
}

/**
 * Execute shielded redeem: Shielded ayUSDC -> Shielded USDC
 *
 * Uses ArmadaYieldAdapter.redeemAndShield - trustless via adaptParams binding.
 */
export async function executeShieldedRedeem(
  params: ShieldedRedeemParams,
  walletId: string,
  encryptionKey: string,
  onProgress?: (progress: ShieldedYieldProgress) => void,
): Promise<ShieldedYieldResult> {
  const { shares, railgunAddress } = params

  console.log('[shielded-yield] Starting shielded redeem via ArmadaYieldAdapter...')
  console.log('[shielded-yield]   Shares:', shares)
  console.log('[shielded-yield]   Railgun Address:', railgunAddress.slice(0, 30) + '...')

  onProgress?.({ stage: 'preparing', message: 'Loading configuration...' })
  await loadDeployments()

  const yieldDeployment = getYieldDeployment()
  const hubChain = getHubChain()

  if (!yieldDeployment) {
    throw new Error('Yield deployment not found')
  }

  const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter
  const vaultAddress = yieldDeployment.contracts.armadaYieldVault
  const usdcAddress = hubChain.contracts?.mockUSDC
  if (!usdcAddress) {
    throw new Error('USDC address not found')
  }

  const sharesRaw = parseUSDC(shares)

  if (!isProverReady()) {
    onProgress?.({ stage: 'init-prover', message: 'Initializing prover...' })
    await initializeProver()
  }

  if (!isHubNetworkLoaded()) {
    await loadHubNetwork()
  }

  const useRelayer = isRelayerEnabled()
  let broadcasterFeeRecipient:
    | { tokenAddress: string; amount: bigint; recipientAddress: string }
    | undefined
  if (useRelayer) {
    const fee = await getRelayerFee('crossContract')
    const relayerRailgunAddr = getRelayerRailgunAddress()
    if (relayerRailgunAddr?.startsWith('0zk')) {
      broadcasterFeeRecipient = {
        tokenAddress: usdcAddress,
        amount: fee,
        recipientAddress: relayerRailgunAddr,
      }
      console.log(`[shielded-yield] Including relayer fee: ${fee.toString()} raw USDC`)
    } else {
      console.warn(
        '[shielded-yield] Relayer enabled but relayerRailgunAddress not configured. ' +
          'Fee omitted from proof. Add relayerRailgunAddress (0zk...) to relayer config for fee collection.',
      )
    }
  }

  onProgress?.({
    stage: 'generating-proof',
    message: 'Generating zero-knowledge proof...',
    proofProgress: 0,
  })

  const proofResult = await generateYieldAdaptRedeemProof({
    walletId,
    encryptionKey,
    shares: sharesRaw,
    railgunAddress,
    adapterAddress,
    usdcAddress,
    vaultAddress,
    broadcasterFeeRecipient,
    sendWithPublicWallet: !useRelayer,
    progressCallback: (progress) => {
      console.log(`[shielded-yield] Proof progress: ${Math.round(progress)}%`)
      onProgress?.({
        stage: 'generating-proof',
        message: `Generating proof... ${Math.round(progress)}%`,
        proofProgress: progress / 100,
      })
    },
  })

  console.log('[shielded-yield] Proof generated, submitting transaction...')

  const { transaction } = proofResult

  if (useRelayer) {
    onProgress?.({ stage: 'confirming', message: 'Submitting to relayer...' })
    const txHash = await submitAndWaitForConfirmation({
      chainId: 31337,
      to: transaction.to,
      data: transaction.data,
    })

    onProgress?.({ stage: 'success', message: 'Shielded redeem complete!' })
    console.log('[shielded-yield] Shielded redeem confirmed via relayer:', txHash)

    return {
      txHash,
      inputAmount: shares,
      outputAmount: shares,
      type: 'redeem',
    }
  }

  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const { ethers } = await import('ethers')
  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  onProgress?.({ stage: 'signing', message: 'Please sign the transaction...' })

  const tx = await signer.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    gasLimit: GAS_ESTIMATE,
  })
  console.log('[shielded-yield] Transaction submitted:', tx.hash)

  onProgress?.({ stage: 'confirming', message: 'Waiting for confirmation...' })

  const receipt = await tx.wait()
  if (!receipt || receipt.status === 0) {
    throw new Error('Shielded redeem transaction failed')
  }

  onProgress?.({ stage: 'success', message: 'Shielded redeem complete!' })

  return {
    txHash: receipt.hash,
    inputAmount: shares,
    outputAmount: shares,
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

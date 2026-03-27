/**
 * Shield Contract Service
 *
 * Handles contract interactions for shield operations:
 * - USDC approval
 * - Direct shield on hub chain (PrivacyPool.shield)
 * - Cross-chain shield on client chains (PrivacyPoolClient.crossChainShield)
 */

import { ethers } from 'ethers'
import {
  loadDeployments,
  getHubChain,
  getChainByKey,
  isHubChain,
  type ChainConfig,
} from '@/config/deployments'
import { isRelayerEnabled, getRelayerFee } from '@/services/relayer'
import { getRelayerAddress, getHookRouterAddress, isCCTPFastMode } from '@/config/networkConfig'

// ============ Contract ABIs ============

const MOCK_USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

// PrivacyPool ABI - used for direct hub shielding
const PRIVACY_POOL_ABI = [
  'function shield((tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external',
  'event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)',
]

// PrivacyPoolClient ABI - used for cross-chain shield from client chains
const PRIVACY_POOL_CLIENT_ABI = [
  'function crossChainShield(uint256 amount, uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] calldata encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller) external returns (uint64)',
  'event CrossChainShieldInitiated(address indexed sender, uint256 amount, bytes32 indexed npk, uint64 nonce)',
]

// Default relayer address (from network config)
const DEFAULT_RELAYER_ADDRESS = getRelayerAddress()

// ============ Types ============

export interface ShieldContractParams {
  amount: bigint
  npk: string // bytes32
  encryptedBundle: [string, string, string] // bytes32[3]
  shieldKey: string // bytes32
}

export interface ShieldResult {
  txHash: string
  nonce?: bigint // Only for cross-chain shields
}

/** Options for shield execution */
export interface ShieldExecutionOptions {
  /** If true, wait for transaction confirmation. Default: false (return immediately after submission) */
  waitForConfirmation?: boolean
}

// ============ Balance & Allowance ============

/**
 * Get public USDC balance for an address on a specific chain
 *
 * @param address - EVM address to check
 * @param chainKey - Chain key ('hub', 'client-a', 'client-b'). Defaults to 'hub'
 */
export async function getPublicUsdcBalance(address: string, chainKey: string = 'hub'): Promise<bigint> {
  await loadDeployments()

  const config = getChainByKey(chainKey)
  if (!config) {
    console.warn(`[shield-contract] No config for chain: ${chainKey}`)
    return 0n
  }

  const usdcAddress = config.contracts?.mockUSDC || config.contracts?.usdc

  if (!usdcAddress) {
    console.warn(`[shield-contract] No USDC address for chain: ${chainKey}`)
    return 0n
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl)
    const usdc = new ethers.Contract(usdcAddress, MOCK_USDC_ABI, provider)
    const balance = await usdc.balanceOf(address)
    return balance
  } catch (error) {
    console.error(`[shield-contract] Failed to get USDC balance on ${chainKey}:`, error)
    return 0n
  }
}

/**
 * Check USDC allowance for the shield contract (PrivacyPool on hub, PrivacyPoolClient on client)
 *
 * @param ownerAddress - Address to check allowance for
 * @param chainKey - Chain key. Defaults to 'hub'
 */
export async function getShieldAllowance(ownerAddress: string, chainKey: string = 'hub'): Promise<bigint> {
  await loadDeployments()

  const config = getChainByKey(chainKey)
  if (!config) {
    console.warn(`[shield-contract] No config for chain: ${chainKey}`)
    return 0n
  }

  const usdcAddress = config.contracts?.mockUSDC || config.contracts?.usdc
  // On hub, we approve PrivacyPool. On client chains, we approve PrivacyPoolClient.
  const spenderAddress = isHubChain(chainKey)
    ? config.contracts?.privacyPool
    : config.contracts?.privacyPoolClient

  if (!usdcAddress || !spenderAddress) {
    console.warn(`[shield-contract] Missing contract addresses for ${chainKey}`)
    return 0n
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl)
    const usdc = new ethers.Contract(usdcAddress, MOCK_USDC_ABI, provider)
    return usdc.allowance(ownerAddress, spenderAddress)
  } catch (error) {
    console.error(`[shield-contract] Failed to get allowance on ${chainKey}:`, error)
    return 0n
  }
}

// ============ Approval ============

/**
 * Approve USDC for shield contract (PrivacyPool on hub, PrivacyPoolClient on client)
 *
 * @param signer - Ethers signer
 * @param chainKey - Chain key. Defaults to 'hub'
 * @param amount - Amount to approve. Defaults to MaxUint256
 */
export async function approveUsdcForShield(
  signer: ethers.Signer,
  chainKey: string = 'hub',
  amount?: bigint,
): Promise<string> {
  await loadDeployments()

  const config = getChainByKey(chainKey)
  if (!config) {
    throw new Error(`No config for chain: ${chainKey}`)
  }

  const usdcAddress = config.contracts?.mockUSDC || config.contracts?.usdc
  // On hub, we approve PrivacyPool. On client chains, we approve PrivacyPoolClient.
  const spenderAddress = isHubChain(chainKey)
    ? config.contracts?.privacyPool
    : config.contracts?.privacyPoolClient

  if (!usdcAddress) {
    throw new Error(`No USDC address for chain: ${chainKey}`)
  }
  if (!spenderAddress) {
    throw new Error(`No shield contract address for chain: ${chainKey}`)
  }

  const usdc = new ethers.Contract(usdcAddress, MOCK_USDC_ABI, signer)
  const approveAmount = amount ?? ethers.MaxUint256

  console.log(`[shield-contract] Approving USDC on ${chainKey}...`, {
    spender: spenderAddress,
    amount: approveAmount.toString(),
  })

  const tx = await usdc.approve(spenderAddress, approveAmount)

  console.log(`[shield-contract] USDC approval submitted on ${chainKey}:`, tx.hash)

  // Wait for tx to be mined (1 confirmation)
  await tx.wait(1)

  console.log(`[shield-contract] USDC approval confirmed on ${chainKey}:`, tx.hash)
  return tx.hash
}

// ============ Shield Execution ============

/**
 * Execute direct shield on hub chain via PrivacyPool.shield()
 *
 * This is used when the user is on the hub chain and wants to shield
 * USDC directly into their private balance.
 */
export async function executeDirectShield(
  signer: ethers.Signer,
  params: ShieldContractParams,
): Promise<ShieldResult> {
  await loadDeployments()
  const hubChain = getHubChain()
  const privacyPoolAddress = hubChain.contracts?.privacyPool
  const usdcAddress = hubChain.contracts?.mockUSDC

  if (!privacyPoolAddress) {
    throw new Error('No PrivacyPool address for hub chain')
  }
  if (!usdcAddress) {
    throw new Error('No MockUSDC address for hub chain')
  }

  console.log('[shield-contract] Executing direct shield...', {
    amount: params.amount.toString(),
    npk: params.npk.slice(0, 20) + '...',
  })

  const pool = new ethers.Contract(privacyPoolAddress, PRIVACY_POOL_ABI, signer)

  // Build the ShieldRequest struct
  const shieldRequest = {
    preimage: {
      npk: params.npk,
      token: {
        tokenType: 0, // ERC20
        tokenAddress: usdcAddress,
        tokenSubID: 0n,
      },
      value: params.amount,
    },
    ciphertext: {
      encryptedBundle: params.encryptedBundle,
      shieldKey: params.shieldKey,
    },
  }

  const tx = await pool.shield([shieldRequest], ethers.ZeroAddress)

  console.log('[shield-contract] Direct shield submitted:', tx.hash)

  // Wait for tx to be mined (1 confirmation to get receipt)
  const receipt = await tx.wait(1)

  if (!receipt || receipt.status === 0) {
    throw new Error('Shield transaction failed')
  }

  console.log('[shield-contract] Direct shield confirmed:', tx.hash)

  return {
    txHash: tx.hash,
  }
}

/**
 * Execute cross-chain shield via PrivacyPoolClient.crossChainShield()
 *
 * This is used when the user is on a client chain and wants to shield
 * USDC across chains into their private balance on the hub.
 *
 * @param signer - Ethers signer connected to the client chain
 * @param clientChainConfig - Configuration for the client chain
 * @param params - Shield parameters
 * @param relayerAddress - Optional relayer address for destinationCaller
 */
export async function executeCrossChainShield(
  signer: ethers.Signer,
  clientChainConfig: ChainConfig,
  params: ShieldContractParams,
  relayerAddress?: string,
): Promise<ShieldResult> {
  const privacyPoolClientAddress = clientChainConfig.contracts?.privacyPoolClient

  if (!privacyPoolClientAddress) {
    throw new Error('No PrivacyPoolClient address for this client chain')
  }

  console.log('[shield-contract] Executing cross-chain shield...', {
    chainId: clientChainConfig.id,
    amount: params.amount.toString(),
    npk: params.npk.slice(0, 20) + '...',
  })

  const client = new ethers.Contract(
    privacyPoolClientAddress,
    PRIVACY_POOL_CLIENT_ABI,
    signer,
  )

  // Set destinationCaller to the hookRouter address (restricts who can call receiveMessage)
  // The hookRouter atomically calls receiveMessage + handleReceiveFinalizedMessage
  const hookRouterAddr = getHookRouterAddress('hub')
  const destinationCaller =
    hookRouterAddr !== ethers.ZeroAddress
      ? ethers.zeroPadValue(hookRouterAddr, 32)
      : ethers.ZeroHash // bytes32(0) = allow any caller

  // Fetch CCTP maxFee for cross-chain shield relay
  let maxFee = 0n
  if (isRelayerEnabled()) {
    maxFee = await getRelayerFee('crossChainShield')
  }

  // User's finality choice: FAST (1000) for ~8-20s or STANDARD (2000) for ~15-19 min
  // Default to FAST when fast mode is enabled, 0 otherwise (contract falls back to STANDARD)
  const minFinalityThreshold = isCCTPFastMode() ? 1000 : 0

  const tx = await client.crossChainShield(
    params.amount,
    maxFee,
    minFinalityThreshold,
    params.npk,
    params.encryptedBundle,
    params.shieldKey,
    destinationCaller,
    ethers.ZeroAddress, // integrator: no integrator for direct user shields
  )

  console.log('[shield-contract] Cross-chain shield submitted:', tx.hash)

  // Wait for tx to be mined (1 confirmation to get receipt)
  const receipt = await tx.wait(1)

  if (!receipt || receipt.status === 0) {
    throw new Error('Cross-chain shield transaction failed')
  }

  // Parse nonce from event
  const iface = new ethers.Interface(PRIVACY_POOL_CLIENT_ABI)
  let nonce: bigint | undefined

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      })
      if (parsed?.name === 'CrossChainShieldInitiated') {
        nonce = parsed.args.nonce
        break
      }
    } catch {
      // Not our event
    }
  }

  console.log('[shield-contract] Cross-chain shield confirmed:', {
    txHash: receipt.hash,
    nonce: nonce?.toString(),
  })

  return {
    txHash: tx.hash,
    nonce,
  }
}

/**
 * Check if approval is needed for shield amount
 *
 * @param ownerAddress - Address to check
 * @param amount - Amount to shield
 * @param chainKey - Chain key. Defaults to 'hub'
 */
export async function isApprovalNeeded(
  ownerAddress: string,
  amount: bigint,
  chainKey: string = 'hub',
): Promise<boolean> {
  const allowance = await getShieldAllowance(ownerAddress, chainKey)
  return allowance < amount
}

/**
 * Shield Service
 *
 * Orchestrates the complete shield flow:
 * 1. Build shield request (create encrypted note)
 * 2. Execute shield transaction (approval + contract call)
 * 3. Save transaction to storage
 *
 * Supports both:
 * - Direct shield on hub chain (PrivacyPool.shield)
 * - Cross-chain shield from client chains (PrivacyPoolClient.crossChainShield)
 */

import { ethers } from 'ethers'
import {
  createShieldRequest,
  formatNpkForContract,
  formatBytes32ForContract,
  type ShieldRequestData,
} from '@/lib/railgun/shield'
import {
  executeDirectShield,
  executeCrossChainShield,
  approveUsdcForShield,
  isApprovalNeeded,
  getPublicUsdcBalance,
  type ShieldContractParams,
} from './shieldContractService'
import { parseUSDC } from '@/lib/sdk'
import { loadDeployments, getHubChain, getChainByKey, isHubChain, type ChainConfig } from '@/config/deployments'

// ============ Types ============

export interface ShieldTransactionParams {
  /** Human readable amount (e.g., "100.50") */
  amount: string
  /** Railgun address (0zk...) */
  railgunAddress: string
  /** EVM address of sender */
  evmAddress: string
  /** Chain key (hub, client-a, client-b) */
  chainKey: string
  /** Shield private key (derived from signature) */
  shieldPrivateKey: string
}

export interface ShieldTransactionDetails {
  amount: string
  amountRaw: bigint
  chainKey: string
  chainName: string
  railgunAddress: string
  senderAddress: string
  txHash?: string
  nonce?: bigint
  approvalTxHash?: string
  isCrossChain: boolean
}

export type ShieldStage =
  | 'preparing'
  | 'approving'
  | 'building'
  | 'signing'
  | 'submitting'
  | 'success'
  | 'error'

export interface ShieldProgress {
  stage: ShieldStage
  message: string
}

// ============ Main Functions ============

/**
 * Build a shield request (creates encrypted note data)
 *
 * This doesn't require any on-chain interaction - it uses the SDK
 * to create the encrypted note data that will be submitted to the contract.
 */
export async function buildShieldRequest(
  railgunAddress: string,
  amount: bigint,
  tokenAddress: string,
  shieldPrivateKey: string,
): Promise<ShieldRequestData> {
  console.log('[shield-service] Building shield request...', {
    railgunAddress: railgunAddress.slice(0, 20) + '...',
    amount: amount.toString(),
    tokenAddress,
  })

  const shieldRequest = await createShieldRequest(
    railgunAddress,
    amount,
    tokenAddress,
    shieldPrivateKey,
  )

  console.log('[shield-service] Shield request built:', {
    npk: shieldRequest.npk.slice(0, 20) + '...',
    value: shieldRequest.value.toString(),
  })

  return shieldRequest
}

/**
 * Execute a shield transaction
 *
 * This handles the full flow:
 * 1. Check and perform approval if needed
 * 2. Build the shield request
 * 3. Submit the shield transaction
 *
 * On hub chain: Calls PrivacyPool.shield() directly
 * On client chains: Calls PrivacyPoolClient.crossChainShield() for cross-chain CCTP transfer
 */
export async function executeShieldTransaction(
  params: ShieldTransactionParams,
  onProgress?: (progress: ShieldProgress) => void,
): Promise<ShieldTransactionDetails> {
  const { amount, railgunAddress, evmAddress, chainKey } = params

  // Parse amount to base units
  const amountRaw = parseUSDC(amount)

  // Get chain configuration
  await loadDeployments()

  const chainConfig = getChainByKey(chainKey)
  if (!chainConfig) {
    throw new Error(`Unknown chain: ${chainKey}`)
  }

  // Get token address for the selected chain
  const tokenAddress = chainConfig.contracts?.mockUSDC || chainConfig.contracts?.usdc
  if (!tokenAddress) {
    throw new Error(`No USDC address configured for chain: ${chainKey}`)
  }

  // Determine if this is a cross-chain shield
  const isCrossChain = !isHubChain(chainKey)

  // Create result object
  const details: ShieldTransactionDetails = {
    amount,
    amountRaw,
    chainKey,
    chainName: chainConfig.name,
    railgunAddress,
    senderAddress: evmAddress,
    isCrossChain,
  }

  // Get signer from MetaMask
  if (!window.ethereum) {
    throw new Error('MetaMask not available')
  }

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  // Verify signer address matches
  const signerAddress = await signer.getAddress()
  if (signerAddress.toLowerCase() !== evmAddress.toLowerCase()) {
    throw new Error('Signer address does not match expected address')
  }

  // Verify the connected network matches the selected chain, switch if needed
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== chainConfig.id) {
    console.log(`[shield-service] Switching network from ${network.chainId} to ${chainConfig.id}`)
    onProgress?.({ stage: 'preparing', message: `Switching to ${chainConfig.name}...` })

    try {
      // Request MetaMask to switch to the target chain
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainConfig.id.toString(16)}` }],
      })

      // Wait a moment for the provider to update
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Re-create provider after chain switch
      const newProvider = new ethers.BrowserProvider(window.ethereum)
      const newNetwork = await newProvider.getNetwork()

      if (Number(newNetwork.chainId) !== chainConfig.id) {
        throw new Error(`Failed to switch to ${chainConfig.name}`)
      }

      // Update signer reference
      const newSigner = await newProvider.getSigner()

      // Continue with the new signer (we need to reassign, so we'll use a helper)
      return executeShieldWithSigner(
        newSigner,
        params,
        chainConfig,
        chainKey,
        amountRaw,
        isCrossChain,
        details,
        onProgress,
      )
    } catch (switchError: unknown) {
      // If the chain doesn't exist in MetaMask, try to add it
      if (
        switchError &&
        typeof switchError === 'object' &&
        'code' in switchError &&
        (switchError as { code: number }).code === 4902
      ) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: `0x${chainConfig.id.toString(16)}`,
                chainName: chainConfig.name,
                rpcUrls: [chainConfig.rpcUrl],
                nativeCurrency: {
                  name: 'Ether',
                  symbol: 'ETH',
                  decimals: 18,
                },
              },
            ],
          })

          // Try switching again after adding
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${chainConfig.id.toString(16)}` }],
          })

          await new Promise((resolve) => setTimeout(resolve, 500))

          const newProvider = new ethers.BrowserProvider(window.ethereum)
          const newSigner = await newProvider.getSigner()

          return executeShieldWithSigner(
            newSigner,
            params,
            chainConfig,
            chainKey,
            amountRaw,
            isCrossChain,
            details,
            onProgress,
          )
        } catch (addError) {
          console.error('[shield-service] Failed to add chain:', addError)
          throw new Error(`Failed to add ${chainConfig.name} to MetaMask`)
        }
      }

      // User rejected or other error
      console.error('[shield-service] Failed to switch chain:', switchError)
      throw new Error(`Please switch MetaMask to ${chainConfig.name} (chain ID: ${chainConfig.id})`)
    }
  }

  // Continue with shield execution using the current signer
  return executeShieldWithSigner(
    signer,
    params,
    chainConfig,
    chainKey,
    amountRaw,
    isCrossChain,
    details,
    onProgress,
  )
}

/**
 * Validate shield parameters before execution
 */
export async function validateShieldParams(
  params: ShieldTransactionParams,
): Promise<{ valid: boolean; error?: string }> {
  const { amount, railgunAddress, evmAddress, chainKey } = params

  // Validate Railgun address
  if (!railgunAddress || !railgunAddress.startsWith('0zk')) {
    return { valid: false, error: 'Invalid Railgun address' }
  }

  // Validate amount
  const amountRaw = parseUSDC(amount)
  if (amountRaw <= 0n) {
    return { valid: false, error: 'Amount must be greater than 0' }
  }

  // Check balance on the selected chain
  const balance = await getPublicUsdcBalance(evmAddress, chainKey)
  if (balance < amountRaw) {
    return { valid: false, error: 'Insufficient USDC balance' }
  }

  return { valid: true }
}

// ============ Helper Functions ============

/**
 * Execute shield transaction with a given signer (used after chain switch)
 */
async function executeShieldWithSigner(
  signer: ethers.Signer,
  params: ShieldTransactionParams,
  chainConfig: ChainConfig,
  chainKey: string,
  amountRaw: bigint,
  isCrossChain: boolean,
  details: ShieldTransactionDetails,
  onProgress?: (progress: ShieldProgress) => void,
): Promise<ShieldTransactionDetails> {
  const { amount, railgunAddress, evmAddress, shieldPrivateKey } = params

  // Step 1: Check if approval is needed
  onProgress?.({ stage: 'preparing', message: 'Checking approval...' })

  const needsApproval = await isApprovalNeeded(evmAddress, amountRaw, chainKey)

  if (needsApproval) {
    onProgress?.({ stage: 'approving', message: 'Approving USDC...' })

    try {
      const approvalTxHash = await approveUsdcForShield(signer, chainKey)
      details.approvalTxHash = approvalTxHash
      console.log('[shield-service] Approval complete:', approvalTxHash)
    } catch (error) {
      console.error('[shield-service] Approval failed:', error)
      throw error
    }
  }

  // Step 2: Build shield request
  // For cross-chain shield, we need to use the hub's USDC address in the note
  // since that's where the funds will end up
  const hubChain = getHubChain()
  const hubTokenAddress = hubChain.contracts?.mockUSDC || hubChain.contracts?.usdc
  if (!hubTokenAddress) {
    throw new Error('No USDC address configured for hub chain')
  }

  onProgress?.({ stage: 'building', message: 'Building shield request...' })

  const shieldRequest = await buildShieldRequest(
    railgunAddress,
    amountRaw,
    hubTokenAddress, // Always use hub token address for the note
    shieldPrivateKey,
  )

  // Format values for contract call
  const contractParams: ShieldContractParams = {
    amount: amountRaw,
    npk: formatNpkForContract(shieldRequest.npk),
    encryptedBundle: [
      formatBytes32ForContract(shieldRequest.encryptedBundle[0]),
      formatBytes32ForContract(shieldRequest.encryptedBundle[1]),
      formatBytes32ForContract(shieldRequest.encryptedBundle[2]),
    ],
    shieldKey: formatBytes32ForContract(shieldRequest.shieldKey),
  }

  // Step 3: Execute shield
  onProgress?.({ stage: 'signing', message: 'Please sign the transaction...' })

  try {
    onProgress?.({ stage: 'submitting', message: 'Submitting transaction...' })

    if (isCrossChain) {
      // Cross-chain shield via PrivacyPoolClient
      console.log('[shield-service] Executing cross-chain shield from', chainKey)

      const result = await executeCrossChainShield(signer, chainConfig, contractParams)

      details.txHash = result.txHash
      details.nonce = result.nonce

      onProgress?.({
        stage: 'success',
        message: 'Cross-chain shield initiated! Waiting for CCTP relay...',
      })

      console.log('[shield-service] Cross-chain shield initiated:', {
        txHash: result.txHash,
        nonce: result.nonce?.toString(),
        amount: amount,
      })
    } else {
      // Direct shield on hub chain via PrivacyPool
      console.log('[shield-service] Executing direct shield on hub')

      const result = await executeDirectShield(signer, contractParams)

      details.txHash = result.txHash
      details.nonce = result.nonce

      onProgress?.({ stage: 'success', message: 'Shield complete!' })

      console.log('[shield-service] Shield transaction complete:', {
        txHash: result.txHash,
        amount: amount,
      })
    }

    return details
  } catch (error) {
    onProgress?.({
      stage: 'error',
      message: error instanceof Error ? error.message : 'Shield failed',
    })
    throw error
  }
}

// Re-export useful functions from contract service
export { getPublicUsdcBalance, getShieldAllowance, isApprovalNeeded } from './shieldContractService'

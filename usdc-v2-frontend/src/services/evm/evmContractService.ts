/**
 * EVM contract service for USDC contract interactions.
 * Handles balance checks, allowance checks, approvals, and depositForBurn calls.
 */

import { ethers } from 'ethers'
import { getUsdcContractAddress } from '@/services/balance/evmBalanceService'
import { jotaiStore } from '@/store/jotaiStore'
import { chainConfigAtom } from '@/atoms/appAtom'
import { findChainByKey } from '@/config/chains'
import { getEvmSigner, getEvmProvider } from './evmNetworkService'
import { logger } from '@/utils/logger'

const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
] as const

const TOKEN_MESSENGER_ABI = [
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) external returns (uint64 nonce)',
] as const

export interface DepositForBurnParams {
  chainKey: string
  amountUsdc: string
  forwardingAddressBytes32: string
  destinationDomain?: number
  onSigningComplete?: () => void
}

export interface DepositForBurnResult {
  txHash: string
  nonce?: string
}

/**
 * Get token messenger contract address for a given chain key.
 * @param chainKey - The chain key
 * @returns Token messenger address, or undefined if not found
 */
export function getTokenMessengerAddress(chainKey: string): string | undefined {
  const chainConfig = jotaiStore.get(chainConfigAtom)
  if (!chainConfig) {
    return undefined
  }

  const chain = findChainByKey(chainConfig, chainKey)
  return chain?.contracts.tokenMessenger
}

/**
 * Get CCTP domain ID for a given chain key.
 * @param chainKey - The chain key
 * @returns CCTP domain ID, or undefined if not found
 */
export function getCctpDomain(chainKey: string): number | undefined {
  const chainConfig = jotaiStore.get(chainConfigAtom)
  if (!chainConfig) {
    return undefined
  }

  const chain = findChainByKey(chainConfig, chainKey)
  return chain?.cctpDomain
}

/**
 * Checks USDC balance for a given address on a chain.
 * @param chainKey - The chain key
 * @param address - The address to check
 * @returns Balance in wei (6 decimals for USDC)
 */
export async function checkUsdcBalance(
  chainKey: string,
  address: string
): Promise<bigint> {
  const usdcAddress = getUsdcContractAddress(chainKey)

  if (!usdcAddress) {
    throw new Error(`Chain configuration not found for: ${chainKey}`)
  }

  const provider = await getEvmProvider(chainKey)
  const usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, provider)

  return await usdcContract.balanceOf(address)
}

/**
 * Checks USDC allowance for a given owner and spender.
 * @param chainKey - The chain key
 * @param owner - The owner address
 * @param spender - The spender address
 * @returns Allowance in wei (6 decimals for USDC)
 */
export async function checkUsdcAllowance(
  chainKey: string,
  owner: string,
  spender: string
): Promise<bigint> {
  const usdcAddress = getUsdcContractAddress(chainKey)

  if (!usdcAddress) {
    throw new Error(`Chain configuration not found for: ${chainKey}`)
  }

  const provider = await getEvmProvider(chainKey)
  const usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, provider)

  return await usdcContract.allowance(owner, spender)
}

/**
 * Approves USDC spending for a given spender.
 * Uses a large approval amount (1M USDC) for better UX.
 * @param chainKey - The chain key
 * @param spender - The spender address (token messenger)
 * @param amount - Optional amount to approve (defaults to 1M USDC)
 * @returns Transaction hash
 */
export async function approveUsdc(
  chainKey: string,
  spender: string,
  amount?: bigint
): Promise<string> {
  const usdcAddress = getUsdcContractAddress(chainKey)

  if (!usdcAddress) {
    throw new Error(`USDC address not configured for chain: ${chainKey}`)
  }

  const signer = await getEvmSigner()
  const usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, signer)

  // Default to 1M USDC approval for better UX (matches reference implementation)
  const approvalAmount = amount || ethers.parseUnits('1000000', 6)

  logger.debug('[EvmContractService] Approving USDC', {
    chainKey,
    spender,
    amount: ethers.formatUnits(approvalAmount, 6),
  })

  try {
    const tx = await usdcContract.approve(spender, approvalAmount)
    logger.debug('[EvmContractService] Approval transaction submitted', {
      txHash: tx.hash,
    })

    const receipt = await tx.wait()
    logger.debug('[EvmContractService] Approval confirmed', {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    })

    return receipt.hash
  } catch (error) {
    console.error('[EvmContractService] Approval failed', {
      chainKey,
      spender,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(
      `USDC approval failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Executes depositForBurn on the token messenger contract.
 * @param params - Deposit parameters
 * @returns Transaction hash and nonce (if available)
 */
export async function depositForBurn(
  params: DepositForBurnParams
): Promise<DepositForBurnResult> {
  const { chainKey, amountUsdc, forwardingAddressBytes32, destinationDomain, onSigningComplete } =
    params

  const usdcAddress = getUsdcContractAddress(chainKey)
  const tokenMessengerAddress = getTokenMessengerAddress(chainKey)
  const cctpDomain = destinationDomain ?? getCctpDomain(chainKey)

  if (!usdcAddress) {
    throw new Error(`USDC address not configured for chain: ${chainKey}`)
  }
  if (!tokenMessengerAddress) {
    throw new Error(`TokenMessenger address not configured for chain: ${chainKey}`)
  }
  if (cctpDomain === undefined) {
    throw new Error(`CCTP domain not configured for chain: ${chainKey}`)
  }

  logger.info('[EvmContractService] 🚀 Executing depositForBurn', {
    chainKey,
    amountUsdc,
    usdcAddress,
    tokenMessengerAddress,
    destinationDomain: cctpDomain,
    forwardingAddressBytes32,
  })

  const signer = await getEvmSigner()
  const walletAddress = await signer.getAddress()
  logger.info('[EvmContractService] 👤 Wallet address', {
    walletAddress,
  })

  // Check balance
  logger.info('[EvmContractService] 💰 Checking USDC balance...')
  const balance = await checkUsdcBalance(chainKey, walletAddress)
  const amountWei = ethers.parseUnits(amountUsdc, 6)
  logger.info('[EvmContractService] 💰 Balance check result', {
    balance: ethers.formatUnits(balance, 6),
    amountRequired: amountUsdc,
    amountWei: amountWei.toString(),
    balanceWei: balance.toString(),
    sufficient: balance >= amountWei,
  })

  if (balance < amountWei) {
    throw new Error(
      `Insufficient USDC balance: have ${ethers.formatUnits(balance, 6)}, need ${amountUsdc}`
    )
  }

  // Check allowance
  logger.info('[EvmContractService] ✅ Checking USDC allowance...')
  const allowance = await checkUsdcAllowance(
    chainKey,
    walletAddress,
    tokenMessengerAddress
  )
  logger.info('[EvmContractService] ✅ Allowance check result', {
    allowance: ethers.formatUnits(allowance, 6),
    amountRequired: amountUsdc,
    allowanceWei: allowance.toString(),
    amountWei: amountWei.toString(),
    sufficient: allowance >= amountWei,
  })

  if (allowance < amountWei) {
    logger.info('[EvmContractService] ⚠️  Insufficient allowance, approving...')
    const approveTxHash = await approveUsdc(chainKey, tokenMessengerAddress)
    logger.info('[EvmContractService] ✅ Approval transaction confirmed', {
      approveTxHash,
    })
  } else {
    logger.info('[EvmContractService] ✅ Sufficient allowance, skipping approval')
  }

  // Execute depositForBurn
  const tokenMessenger = new ethers.Contract(
    tokenMessengerAddress,
    TOKEN_MESSENGER_ABI,
    signer
  )

  try {
    logger.info('[EvmContractService] 📝 Calling depositForBurn with parameters:', {
      amount: amountWei.toString(),
      amountFormatted: ethers.formatUnits(amountWei, 6),
      destinationDomain: cctpDomain,
      mintRecipient: forwardingAddressBytes32,
      burnToken: usdcAddress,
    })

    const tx = await tokenMessenger.depositForBurn(
      amountWei,
      cctpDomain,
      forwardingAddressBytes32,
      usdcAddress
    )

    logger.info('[EvmContractService] 📤 depositForBurn transaction submitted', {
      txHash: tx.hash,
      from: walletAddress,
      to: tokenMessengerAddress,
    })

    // Signing is complete when the transaction is submitted (user approved in MetaMask)
    // Now we're in the submitting phase (waiting for confirmation)
    onSigningComplete?.()

    logger.info('[EvmContractService] ⏳ Waiting for transaction confirmation...')
    const receipt = await tx.wait()
    logger.info('[EvmContractService] ✅ depositForBurn confirmed', {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.gasPrice?.toString(),
      status: receipt.status,
      logsCount: receipt.logs.length,
    })

    // Extract nonce from receipt logs
    logger.info('[EvmContractService] 🔍 Extracting nonce from receipt logs...')
    let nonce: string | undefined
    try {
      const iface = new ethers.Interface(TOKEN_MESSENGER_ABI)
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log)
          if (parsed && parsed.name === 'DepositForBurn') {
            nonce = parsed.args?.nonce?.toString()
            logger.info('[EvmContractService] ✅ Nonce extracted from logs', {
              nonce,
              eventName: parsed.name,
            })
            break
          }
        } catch {
          // Ignore parsing errors for logs that don't match
        }
      }
      if (!nonce) {
        logger.warn('[EvmContractService] ⚠️  Nonce not found in receipt logs', {
          logsCount: receipt.logs.length,
        })
      }
    } catch (error) {
      logger.warn('[EvmContractService] ⚠️  Failed to extract nonce', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    logger.info('[EvmContractService] ✅ depositForBurn completed successfully', {
      txHash: receipt.hash,
      nonce: nonce || 'not extracted',
    })

    return {
      txHash: receipt.hash,
      nonce,
    }
  } catch (error) {
    console.error('[EvmContractService] depositForBurn failed', {
      chainKey,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(
      `depositForBurn failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}


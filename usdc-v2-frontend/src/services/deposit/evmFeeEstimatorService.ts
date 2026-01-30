/**
 * EVM fee estimator service for deposit transactions.
 * Estimates gas fees for EVM contract calls.
 * Initially stubbed, can be extended to fetch from JSON endpoint or estimate actual gas costs.
 */

import { ethers } from 'ethers'
import { getEvmProvider, getEvmSigner } from '@/services/evm/evmNetworkService'
import { getUsdcContractAddress } from '@/services/balance/evmBalanceService'
import { getTokenMessengerAddress, checkUsdcAllowance } from '@/services/evm/evmContractService'
import { findChainByKey } from '@/config/chains'
import { jotaiStore } from '@/store/jotaiStore'
import { chainConfigAtom } from '@/atoms/appAtom'
import { fetchNativeTokenPrice } from '@/services/deposit/nativeTokenPriceService'
import { logger } from '@/utils/logger'
import { env } from '@/config/env'

// Cache for fee estimates (chainKey -> amount -> fee)
const feeCache = new Map<string, Map<string, string>>()

/**
 * Convert uusdc (micro USDC) to USD
 * @param uusdc - Amount in uusdc as string
 * @returns Amount in USD as number
 */
function convertUusdcToUsd(uusdc: string): number {
  return Number.parseInt(uusdc, 10) / 1_000_000
}

const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
] as const

const TOKEN_MESSENGER_ABI = [
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) external returns (uint64 nonce)',
] as const

/**
 * Fetch estimated EVM fee for a deposit transaction.
 * Currently stubbed to return a fixed fee or chain-specific fees.
 * 
 * @param chainKey - The chain key (e.g., 'base', 'ethereum')
 * @param amount - The deposit amount (as string)
 * @returns Estimated fee as a string (e.g., "0.12")
 */
export async function fetchEstimatedEvmFee(
  chainKey: string,
  amount: string
): Promise<string> {
  // Check cache first
  const cached = getCachedEvmFee(chainKey, amount)
  if (cached !== null) {
    return cached
  }

  // TODO: Replace with actual API call to fetch fees from JSON endpoint
  // Example: const response = await fetch(`/api/fees/evm?chain=${chainKey}&amount=${amount}`)
  // Or estimate actual gas costs using ethers provider
  // For now, return a stubbed fee based on chain
  const stubbedFee = getStubbedEvmFee(chainKey, amount)

  // Cache the result
  if (!feeCache.has(chainKey)) {
    feeCache.set(chainKey, new Map())
  }
  feeCache.get(chainKey)!.set(amount, stubbedFee)

  return stubbedFee
}

/**
 * Get cached EVM fee for a chain and amount combination.
 * 
 * @param chainKey - The chain key
 * @param amount - The deposit amount
 * @returns Cached fee or null if not cached
 */
export function getCachedEvmFee(chainKey: string, amount: string): string | null {
  const chainCache = feeCache.get(chainKey)
  if (!chainCache) {
    return null
  }
  return chainCache.get(amount) ?? null
}

/**
 * Clear the fee cache for a specific chain or all chains.
 * 
 * @param chainKey - Optional chain key to clear. If not provided, clears all caches.
 */
export function clearEvmFeeCache(chainKey?: string): void {
  if (chainKey) {
    feeCache.delete(chainKey)
  } else {
    feeCache.clear()
  }
}

/**
 * Get stubbed EVM fee based on chain and amount.
 * This is a temporary implementation until real fee estimation is available.
 * Different chains may have different gas prices, so we adjust fees accordingly.
 * 
 * @param chainKey - The chain key
 * @param amount - The deposit amount (not used in stubbed version)
 * @returns Stubbed fee as a string
 */
function getStubbedEvmFee(chainKey: string, _amount: string): string {
  // Base fee for all chains (in USD, approximating gas costs)
  const baseFee = 0.12

  // Adjust fee based on chain (some chains have lower gas prices)
  const chainMultipliers: Record<string, number> = {
    ethereum: 1.2, // Higher gas on Ethereum
    base: 0.8, // Lower gas on Base
    avalanche: 0.9,
    polygon: 0.7, // Lower gas on Polygon
    arbitrum: 0.6, // Lower gas on Arbitrum
  }

  const multiplier = chainMultipliers[chainKey] ?? 1.0
  const fee = baseFee * multiplier

  // Round to 2 decimal places
  return fee.toFixed(2)
}

/**
 * Deposit fee information for display purposes.
 */
export interface DepositFeeInfo {
  // Native token amounts (primary)
  approveNative: string // e.g., "0.0005" or "0" if not needed
  burnNative: string // e.g., "0.002"
  totalNative: string // e.g., "0.0025" (only includes approve if needed)
  nativeSymbol: string // e.g., "ETH", "AVAX", "POL"
  nativeDecimals: number // e.g., 18
  
  // Approval status (optional, for UI clarity)
  approvalNeeded?: boolean // true if approval is required
  
  // USD amounts (optional, for Phase 2 - will be added later)
  approveUsd?: number
  burnUsd?: number
  totalUsd?: number
  
  // Noble registration (always in USD, it's a USDC fee, configurable via env.nobleRegFeeUusdc())
  nobleRegUsd: number
  
  // Gas price for reference
  gasPrice: string
}

/**
 * Estimate deposit fees for display purposes using actual EVM gas estimation.
 * This estimates gas for approve and depositForBurn transactions and returns native token amounts.
 *
 * @param chainKey - The EVM chain key
 * @param amountUsdc - The deposit amount (optional, for future use)
 * @param evmAddress - The EVM address (for gas estimation)
 * @returns Fee breakdown including approve, burn, Noble registration, and total fees in native token
 */
export async function estimateDepositFeeForDisplay(
  chainKey: string,
  amountUsdc: string | undefined,
  evmAddress: string,
): Promise<DepositFeeInfo> {
  logger.debug('[EvmFeeEstimator] Estimating deposit fee for display', {
    chainKey,
    amount: amountUsdc,
    evmAddress: evmAddress.slice(0, 10) + '...',
  })

  // Get chain config to access native currency info
  const chainConfig = jotaiStore.get(chainConfigAtom)
  const chain = findChainByKey(chainConfig, chainKey)

  if (!chain) {
    throw new Error(`Chain configuration not found for: ${chainKey}`)
  }

  // Get native currency info from chain config
  const nativeSymbol = chain.nativeCurrency.symbol
  const nativeDecimals = chain.nativeCurrency.decimals

  logger.debug('[EvmFeeEstimator] Native currency info', {
    chainKey,
    nativeSymbol,
    nativeDecimals,
  })

  // Get contract addresses
  const usdcAddress = getUsdcContractAddress(chainKey)
  const tokenMessengerAddress = getTokenMessengerAddress(chainKey)

  if (!usdcAddress || !tokenMessengerAddress) {
    throw new Error(`Contract addresses not found for chain: ${chainKey}`)
  }

  // Get EVM provider
  let provider: ethers.Provider | null = null
  let signer: ethers.Signer | null = null
  let wallet: string | null = null

  try {
    provider = await getEvmProvider(chainKey)
    try {
      signer = await getEvmSigner()
      wallet = await signer.getAddress()
      logger.debug('[EvmFeeEstimator] Got signer and wallet', {
        wallet: wallet.slice(0, 10) + '...',
      })
    } catch (e) {
      logger.warn('[EvmFeeEstimator] Signer not available yet, falling back to partial estimate', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  } catch (error) {
    logger.warn('[EvmFeeEstimator] Failed to get provider, using fallback values', {
      error: error instanceof Error ? error.message : String(error),
    })
    // Return fallback values in native token terms
    // Note: In fallback case, we can't check allowance, so we assume approval is needed (safer)
    const fallbackGasPrice = 1000000000n // 1 gwei
    const fallbackApproveGas = 50000n
    const fallbackBurnGas = 200000n
    
    const nativeDecimalsDivisor = 10 ** nativeDecimals
    const fallbackApproveNative = Number(fallbackApproveGas * fallbackGasPrice) / nativeDecimalsDivisor
    const fallbackBurnNative = Number(fallbackBurnGas * fallbackGasPrice) / nativeDecimalsDivisor
    const fallbackTotalNative = fallbackApproveNative + fallbackBurnNative
    
    // Format native token amounts with appropriate precision
    const formatNativeAmount = (amount: number): string => {
      if (amount === 0) return '0'
      if (amount < 0.000001) {
        return amount.toFixed(12).replace(/\.?0+$/, '')
      }
      return amount.toFixed(6).replace(/\.?0+$/, '')
    }

    // Try to fetch price for USD estimates (optional)
    let nativeTokenPrice: number | null = null
    let approveUsd: number | undefined
    let burnUsd: number | undefined
    let totalUsd: number | undefined

    try {
      nativeTokenPrice = await fetchNativeTokenPrice(chainKey)
      if (nativeTokenPrice !== null) {
        approveUsd = fallbackApproveNative * nativeTokenPrice
        burnUsd = fallbackBurnNative * nativeTokenPrice
        totalUsd = fallbackTotalNative * nativeTokenPrice
      }
    } catch (error) {
      // USD estimates remain undefined if price fetch fails
      logger.debug('[EvmFeeEstimator] Price fetch failed in fallback case', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    
    return {
      approveNative: formatNativeAmount(fallbackApproveNative),
      burnNative: formatNativeAmount(fallbackBurnNative),
      totalNative: formatNativeAmount(fallbackTotalNative),
      nativeSymbol,
      nativeDecimals,
      approvalNeeded: true, // Assume approval needed in fallback case
      approveUsd,
      burnUsd,
      totalUsd,
      nobleRegUsd: convertUusdcToUsd(env.nobleRegFeeUusdc()),
      gasPrice: fallbackGasPrice.toString(),
    }
  }

  // Get gas price (EIP-1559 aware)
  let gasPrice: bigint = 0n
  try {
    if (provider) {
      const feeData = await provider.getFeeData()
      gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
      logger.debug('[EvmFeeEstimator] Got gas price', {
        gasPrice: gasPrice.toString(),
        maxFeePerGas: feeData.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
      })
    }
  } catch (e) {
    logger.warn('[EvmFeeEstimator] getFeeData failed, trying eth_gasPrice', {
      error: e instanceof Error ? e.message : String(e),
    })
    try {
      if (provider) {
        const raw: string = await (provider as any).send('eth_gasPrice', [])
        gasPrice = BigInt(raw)
        logger.debug('[EvmFeeEstimator] eth_gasPrice', { gasPrice: gasPrice.toString() })
      }
    } catch (e2) {
      logger.warn('[EvmFeeEstimator] eth_gasPrice failed, using fallback', {
        error: e2 instanceof Error ? e2.message : String(e2),
      })
      gasPrice = 1000000000n // 1 gwei fallback
    }
  }

  // 1) Check allowance first to determine if approval is needed
  let approvalNeeded = false
  let approveGas = 0n

  if (amountUsdc && provider && evmAddress) {
    try {
      const depositAmountWei = ethers.parseUnits(amountUsdc, 6)
      const currentAllowance = await checkUsdcAllowance(
        chainKey,
        evmAddress,
        tokenMessengerAddress,
      )

      approvalNeeded = currentAllowance < depositAmountWei

      logger.debug('[EvmFeeEstimator] Allowance check', {
        currentAllowance: ethers.formatUnits(currentAllowance, 6),
        depositAmount: amountUsdc,
        approvalNeeded,
      })
    } catch (e) {
      logger.warn('[EvmFeeEstimator] Allowance check failed, assuming approval needed', {
        error: e instanceof Error ? e.message : String(e),
      })
      // If check fails, assume approval is needed (safer)
      approvalNeeded = true
    }
  } else {
    // If no amount or address, assume approval is needed (safer)
    logger.debug('[EvmFeeEstimator] No amount or address provided, assuming approval needed')
    approvalNeeded = true
  }

  // 2) Estimate approve gas only if needed
  if (approvalNeeded) {
    try {
      if (signer && wallet && provider) {
        const usdc = new ethers.Contract(usdcAddress, USDC_ABI, signer)
        // Use large approval amount (1M USDC) to match the actual approval logic
        const largeApprovalAmount = ethers.parseUnits('1000000', 6) // 1M USDC
        const approveTx = await usdc.approve.populateTransaction(tokenMessengerAddress, largeApprovalAmount)
        const txForEst: any = { ...approveTx, from: wallet }
        if (gasPrice > 0n) {
          // Prefer legacy gasPrice for estimate if EIP-1559 fields are absent
          if (!('maxFeePerGas' in txForEst) && !('maxPriorityFeePerGas' in txForEst)) {
            txForEst.gasPrice = gasPrice
          }
        }
        approveGas = await provider.estimateGas(txForEst)
        logger.debug('[EvmFeeEstimator] Approve gas estimated', {
          approveGas: approveGas.toString(),
        })
      } else {
        logger.debug('[EvmFeeEstimator] Skipping approve gas estimate (no signer)')
        // Fallback gas estimate for approve transaction
        approveGas = 50000n
      }
    } catch (e) {
      logger.warn('[EvmFeeEstimator] Approve gas estimate failed, using fallback', {
        error: e instanceof Error ? e.message : String(e),
      })
      // Fallback gas estimate for approve transaction
      approveGas = 50000n
    }
  } else {
    logger.debug('[EvmFeeEstimator] Approval not needed, skipping approve gas estimate')
    approveGas = 0n
  }

  // 3) Estimate depositForBurn gas (rough; we cannot include dynamic mintRecipient here)
  let burnGas = 0n
  try {
    if (signer && wallet && provider) {
      const tokenMessenger = new ethers.Contract(tokenMessengerAddress, TOKEN_MESSENGER_ABI, signer)
      // Dummy values for estimation; downstream UI calls use accurate execution path.
      // const cctpDomain = getCctpDomain(chainKey) ?? 4 // fallback to noble domain
      // Use a non-zero mintRecipient (bytes32) - all zeros except last byte = 1
      // This passes the "must be nonzero" check while still being a dummy value
      const dummyMintRecipient = '0x0000000000000000000000000000000000000000000000000000000000000001'
      const estimateTx = await tokenMessenger.depositForBurn.populateTransaction(
        1n, // minimal non-zero amount for estimation
        4, // noble domain default
        dummyMintRecipient, // non-zero placeholder mintRecipient (bytes32)
        usdcAddress,
      )
      const txForEst: any = { ...estimateTx, from: wallet }
      if (gasPrice > 0n) {
        if (!('maxFeePerGas' in txForEst) && !('maxPriorityFeePerGas' in txForEst)) {
          txForEst.gasPrice = gasPrice
        }
      }
      burnGas = await provider.estimateGas(txForEst)
      logger.debug('[EvmFeeEstimator] Burn gas estimated', {
        burnGas: burnGas.toString(),
      })
    } else {
      logger.debug('[EvmFeeEstimator] Skipping burn gas estimate (no signer)')
    }
  } catch (e) {
    logger.warn('[EvmFeeEstimator] Burn gas estimate failed, using fallback', {
      error: e instanceof Error ? e.message : String(e),
    })
    // Fallback gas estimate for depositForBurn transaction
    burnGas = 200000n
  }

  // Calculate fees in native token terms
  // Formula: (gas * gasPrice) / 10^nativeDecimals
  const nativeDecimalsDivisor = 10 ** nativeDecimals

  const approveNativeDisplay = Number(approveGas * gasPrice) / nativeDecimalsDivisor
  const burnNativeDisplay = Number(burnGas * gasPrice) / nativeDecimalsDivisor
  const totalNativeDisplay = approveNativeDisplay + burnNativeDisplay

  // 3) Noble registration flat fee (always in USD, converted from uusdc)
  const nobleRegUsd = convertUusdcToUsd(env.nobleRegFeeUusdc())

  // Format native token amounts with appropriate precision
  // For very small amounts (< 0.000001), show more decimal places
  const formatNativeAmount = (amount: number): string => {
    if (amount === 0) return '0'
    if (amount < 0.000001) {
      // For very small amounts, show up to 12 decimal places
      return amount.toFixed(12).replace(/\.?0+$/, '')
    }
    // For normal amounts, show 6 decimal places
    return amount.toFixed(6).replace(/\.?0+$/, '')
  }

  const approveNativeFormatted = formatNativeAmount(approveNativeDisplay)
  const burnNativeFormatted = formatNativeAmount(burnNativeDisplay)
  const totalNativeFormatted = formatNativeAmount(totalNativeDisplay)

  // 4) Fetch native token price for USD estimates (optional, Phase 2)
  let nativeTokenPrice: number | null = null
  let approveUsd: number | undefined
  let burnUsd: number | undefined
  let totalUsd: number | undefined

  try {
    nativeTokenPrice = await fetchNativeTokenPrice(chainKey)
    if (nativeTokenPrice !== null) {
      // Calculate USD amounts
      approveUsd = approveNativeDisplay * nativeTokenPrice
      burnUsd = burnNativeDisplay * nativeTokenPrice
      totalUsd = totalNativeDisplay * nativeTokenPrice

      logger.debug('[EvmFeeEstimator] USD estimates calculated', {
        nativeTokenPrice,
        approveUsd,
        burnUsd,
        totalUsd,
      })
    } else {
      logger.debug('[EvmFeeEstimator] Price fetch failed, USD estimates not available')
    }
  } catch (error) {
    logger.warn('[EvmFeeEstimator] Price fetch error, USD estimates not available', {
      error: error instanceof Error ? error.message : String(error),
    })
    // USD estimates remain undefined if price fetch fails
  }

  logger.debug('[EvmFeeEstimator] Deposit fee estimation complete', {
    approveNative: approveNativeFormatted,
    burnNative: burnNativeFormatted,
    totalNative: totalNativeFormatted,
    nativeSymbol,
    nativeDecimals,
    approvalNeeded,
    approveUsd,
    burnUsd,
    totalUsd,
    nobleRegUsd,
    gasPrice: gasPrice.toString(),
    approveGas: approveGas.toString(),
    burnGas: burnGas.toString(),
  })

  return {
    approveNative: approveNativeFormatted,
    burnNative: burnNativeFormatted,
    totalNative: totalNativeFormatted,
    nativeSymbol,
    nativeDecimals,
    approvalNeeded,
    approveUsd,
    burnUsd,
    totalUsd,
    nobleRegUsd,
    gasPrice: gasPrice.toString(),
  }
}


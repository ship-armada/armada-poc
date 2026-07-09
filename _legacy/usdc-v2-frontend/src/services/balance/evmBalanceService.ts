import { ethers } from 'ethers'
import { jotaiStore } from '@/store/jotaiStore'
import { chainConfigAtom } from '@/atoms/appAtom'
import { findChainByKey } from '@/config/chains'
import { getEffectiveRpcUrl } from '@/services/config/customUrlResolver'

/**
 * Get USDC contract address for a given chain key from chain config.
 * @param chainKey - The chain key (e.g., 'sepolia', 'base-sepolia')
 * @returns USDC contract address, or undefined if chain not found or config not loaded
 */
export function getUsdcContractAddress(chainKey: string): string | undefined {
  const chainConfig = jotaiStore.get(chainConfigAtom)
  // if (!chainConfig) {
  //   console.warn('[EvmBalanceService] Chain config not loaded yet', { chainKey })
  //   return undefined
  // }

  const chain = findChainByKey(chainConfig, chainKey)
  if (!chain) {
    console.warn('[EvmBalanceService] Chain not found in config', { chainKey })
    return undefined
  }

  return chain.contracts.usdc
}

/**
 * Get primary RPC URL for a given chain key from chain config.
 * @deprecated Use getEffectiveRpcUrl from customUrlResolver instead
 * @param chainKey - The chain key (e.g., 'sepolia', 'base-sepolia')
 * @returns Primary RPC URL, or undefined if chain not found or config not loaded
 */
export function getPrimaryRpcUrl(chainKey: string): string | undefined {
  const chainConfig = jotaiStore.get(chainConfigAtom)
  if (!chainConfig) {
    console.warn('[EvmBalanceService] Chain config not loaded yet', { chainKey })
    return undefined
  }

  const chain = findChainByKey(chainConfig, chainKey)
  if (!chain) {
    console.warn('[EvmBalanceService] Chain not found in config', { chainKey })
    return undefined
  }

  return chain.rpcUrls[0]
}

/**
 * Verify that an RPC URL is reachable before creating a provider.
 * This prevents ethers.js from starting its network detection retry loop.
 * @param rpcUrl - The RPC URL to check
 * @param timeoutMs - Timeout in milliseconds (default: 5000ms)
 * @returns true if RPC is reachable, false otherwise
 */
async function verifyRpcReachable(rpcUrl: string, timeoutMs: number = 5000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
        id: 1,
      }),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)
    return response.ok
  } catch (error) {
    // RPC is not reachable (network error, timeout, etc.)
    return false
  }
}

/**
 * Fetch USDC balance for a given EVM address on a specific chain.
 * @param chainKey - The chain key (e.g., 'sepolia', 'base-sepolia')
 * @param address - The EVM address to query
 * @returns Formatted USDC balance as string (6 decimals), or '--' if fetch fails
 */
export async function fetchEvmUsdcBalance(
  chainKey: string,
  address: string
): Promise<string> {
  try {
    // Validate address format
    if (!address || !address.startsWith('0x') || address.length !== 42) {
      console.warn('[EvmBalanceService] Invalid address format', { chainKey, address })
      return '--'
    }

    // Get chain configuration
    const usdcAddress = getUsdcContractAddress(chainKey)
    const rpcUrl = await getEffectiveRpcUrl(chainKey)

    if (!usdcAddress || !rpcUrl) {
      console.warn('[EvmBalanceService] Missing chain configuration', {
        chainKey,
        hasUsdcAddress: !!usdcAddress,
        hasRpcUrl: !!rpcUrl,
      })
      return '--'
    }

    // Verify RPC is reachable before creating provider (prevents retry loop)
    const isReachable = await verifyRpcReachable(rpcUrl, 5000)
    if (!isReachable) {
      throw new Error('Could not query EVM balance from chain')
    }

    // Get chainId from config to create static network (prevents retry loop)
    const chainConfig = jotaiStore.get(chainConfigAtom)
    const chain = findChainByKey(chainConfig, chainKey)
    if (!chain) {
      throw new Error(`Chain not found: ${chainKey}`)
    }

    // Create provider with static network to prevent retry loop on bad RPCs
    const staticNetwork = ethers.Network.from(chain.chainId)
    const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, {
      batchMaxCount: 1, // Disable batching for faster failure
    })

    const contract = new ethers.Contract(
      usdcAddress,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    )

    // Set a timeout for the entire operation (including provider initialization and network detection)
    const timeoutMs = 8000 // 8 seconds timeout - fail fast on bad RPCs
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      const balance = await Promise.race([
        contract.balanceOf(address).finally(() => {
          if (timeoutId) clearTimeout(timeoutId)
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('Could not query EVM balance from chain'))
          }, timeoutMs)
        }),
      ])
      
      if (timeoutId) clearTimeout(timeoutId)

    // Format balance to 6 decimals (USDC has 6 decimals)
    const formatted = ethers.formatUnits(balance, 6)
    // Use toFixed(6) to ensure consistent formatting
    const formattedBalance = Number.parseFloat(formatted).toFixed(6)

    return formattedBalance
    } catch (raceError) {
      if (timeoutId) clearTimeout(timeoutId)
      throw raceError
    }
  } catch (error) {
    console.error('[EvmBalanceService] Failed to fetch USDC balance', {
      chainKey,
      address: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'undefined',
      error: error instanceof Error ? error.message : String(error),
    })
    // Re-throw the error so callers can handle it appropriately
    throw error
  }
}


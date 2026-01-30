/**
 * Timeout Configuration Service
 *
 * Loads and calculates polling timeouts from chain configuration files.
 */

import type { FlowType } from '@/shared/flowStages'
import type { ChainTimeoutConfig, GlobalTimeoutConfig } from './types'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { logger } from '@/utils/logger'

/**
 * Cache for chain timeout configs
 */
let chainTimeoutCache: Map<string, ChainTimeoutConfig> | null = null

/**
 * Default timeout values (fallback if config not available)
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000 // 20 minutes

/**
 * Default global timeout multiplier
 */
const DEFAULT_GLOBAL_TIMEOUT_MULTIPLIER = 1.5

/**
 * Load timeout configuration for a specific chain
 *
 * @param chainKey - Chain key (e.g., 'sepolia')
 * @param flowType - Flow type ('deposit' or 'payment')
 * @returns Timeout in milliseconds
 */
export async function getChainTimeout(
  chainKey: string,
  flowType: FlowType,
): Promise<number> {
  try {
    const configs = await loadChainTimeoutConfigs()
    const config = configs.get(chainKey)

    if (config) {
      const timeoutMs =
        flowType === 'deposit' ? config.depositTimeoutMs : config.paymentTimeoutMs
      if (timeoutMs && timeoutMs > 0) {
        return timeoutMs
      }
    }

    logger.debug('[TimeoutConfig] Using default timeout', {
      chainKey,
      flowType,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    })

    return DEFAULT_TIMEOUT_MS
  } catch (error) {
    logger.warn('[TimeoutConfig] Failed to load timeout config, using default', {
      chainKey,
      flowType,
      error: error instanceof Error ? error.message : String(error),
    })
    return DEFAULT_TIMEOUT_MS
  }
}

/**
 * Calculate global timeout for entire flow
 *
 * @param chainKeys - Array of chain keys in flow order
 * @param flowType - Flow type ('deposit' or 'payment')
 * @param globalConfig - Optional global timeout configuration
 * @returns Global timeout in milliseconds
 */
export async function calculateGlobalTimeout(
  chainKeys: string[],
  flowType: FlowType,
  globalConfig?: GlobalTimeoutConfig,
): Promise<number> {
  try {
    // Sum all chain timeouts
    let sumTimeoutMs = 0
    for (const chainKey of chainKeys) {
      const chainTimeout = await getChainTimeout(chainKey, flowType)
      sumTimeoutMs += chainTimeout
    }

    // Apply multiplier
    const multiplier = globalConfig?.multiplier ?? DEFAULT_GLOBAL_TIMEOUT_MULTIPLIER
    let globalTimeoutMs = sumTimeoutMs * multiplier

    // Apply min/max constraints if provided
    if (globalConfig?.minTimeoutMs && globalTimeoutMs < globalConfig.minTimeoutMs) {
      globalTimeoutMs = globalConfig.minTimeoutMs
    }
    if (globalConfig?.maxTimeoutMs && globalTimeoutMs > globalConfig.maxTimeoutMs) {
      globalTimeoutMs = globalConfig.maxTimeoutMs
    }

    logger.debug('[TimeoutConfig] Calculated global timeout', {
      chainKeys,
      flowType,
      sumTimeoutMs,
      multiplier,
      globalTimeoutMs,
    })

    return globalTimeoutMs
  } catch (error) {
    logger.warn('[TimeoutConfig] Failed to calculate global timeout, using default', {
      chainKeys,
      flowType,
      error: error instanceof Error ? error.message : String(error),
    })
    // Fallback to reasonable default (sum of default timeouts * multiplier)
    return DEFAULT_TIMEOUT_MS * chainKeys.length * DEFAULT_GLOBAL_TIMEOUT_MULTIPLIER
  }
}

/**
 * Load all chain timeout configurations from config files
 *
 * @returns Map of chain key to timeout config
 */
async function loadChainTimeoutConfigs(): Promise<Map<string, ChainTimeoutConfig>> {
  if (chainTimeoutCache) {
    return chainTimeoutCache
  }

  const configs = new Map<string, ChainTimeoutConfig>()

  try {
    // Load EVM chains
    const evmConfig = await fetchEvmChainsConfig()
    for (const chain of evmConfig.chains) {
      if (chain.pollingTimeout) {
        const depositTimeoutMs = chain.pollingTimeout.depositTimeoutMs ?? DEFAULT_TIMEOUT_MS
        const paymentTimeoutMs = chain.pollingTimeout.paymentTimeoutMs ?? DEFAULT_TIMEOUT_MS
        configs.set(chain.key, {
          depositTimeoutMs,
          paymentTimeoutMs,
        })
      }
    }

    chainTimeoutCache = configs
    logger.debug('[TimeoutConfig] Loaded chain timeout configs', {
      count: configs.size,
      chains: Array.from(configs.keys()),
    })
  } catch (error) {
    logger.error('[TimeoutConfig] Failed to load chain timeout configs', {
      error: error instanceof Error ? error.message : String(error),
    })
    // Return empty map, will use defaults
  }

  return configs
}

/**
 * Clear the timeout config cache (useful for testing or config updates)
 */
export function clearTimeoutConfigCache(): void {
  chainTimeoutCache = null
}

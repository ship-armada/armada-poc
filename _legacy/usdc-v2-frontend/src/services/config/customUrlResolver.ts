import { jotaiStore } from '@/store/jotaiStore'
import { customEvmChainUrlsAtom } from '@/atoms/customChainUrlsAtom'
import { fetchEvmChainsConfig } from './chainConfigService'
import { findChainByKey } from '@/config/chains'

/**
 * Get effective RPC URL for an EVM chain with priority:
 * 1. Custom URL from atom
 * 2. Default from JSON config
 */
export async function getEffectiveRpcUrl(chainKey: string): Promise<string> {
  // Check custom URLs first
  const customUrls = jotaiStore.get(customEvmChainUrlsAtom)

  if (customUrls[chainKey]?.rpcUrl) {
    return customUrls[chainKey].rpcUrl!
  }

  // Fall back to JSON config
  const config = await fetchEvmChainsConfig()
  const chain = findChainByKey(config, chainKey)
  if (chain?.rpcUrls?.[0]) {
    return chain.rpcUrls[0]
  }
  throw new Error(`RPC URL not found for EVM chain: ${chainKey}`)
}

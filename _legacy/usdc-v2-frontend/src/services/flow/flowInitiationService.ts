import type { FlowInitiationMetadata, ShieldedMetadata } from '@/types/flow'
import { jotaiStore } from '@/store/jotaiStore'
import { chainConfigAtom } from '@/atoms/appAtom'
import { findChainByKey } from '@/config/chains'
import { logger } from '@/utils/logger'

/**
 * Determine chain type based on chain identifier.
 * Checks if chain is in EVM chains config, otherwise assumes Tendermint.
 */
function getChainType(chainKey: string): 'evm' | 'tendermint' {
  const chainConfig = jotaiStore.get(chainConfigAtom)
  if (chainConfig) {
    const chain = findChainByKey(chainConfig, chainKey)
    if (chain) {
      return 'evm'
    }
  }
  
  // Namada and Noble are Tendermint chains
  if (chainKey.toLowerCase().includes('namada') || chainKey.toLowerCase().includes('noble')) {
    return 'tendermint'
  }
  
  // Default to tendermint for unknown chains
  return 'tendermint'
}

/**
 * Service for initiating flows locally.
 * Flow metadata is stored directly in transactions instead of separate flows storage.
 */
class FlowInitiationService {
  /**
   * Create flow initiation metadata.
   * This creates the metadata object but does NOT save it - it should be stored in the transaction's flowMetadata field.
   * 
   * @param flowType - Type of flow ('deposit' or 'payment')
   * @param initialChain - Chain identifier where flow starts
   * @param amount - Token amount in base units
   * @param shieldedMetadata - Optional shielded transaction metadata (client-side only)
   * @returns Flow initiation metadata with localId
   */
  createFlowMetadata(
    flowType: 'deposit' | 'payment',
    initialChain: string,
    amount: string,
    shieldedMetadata?: ShieldedMetadata,
  ): FlowInitiationMetadata {
    const localId = crypto.randomUUID()
    const initialChainType = getChainType(initialChain)
    
    const initiationMetadata: FlowInitiationMetadata = {
      localId,
      flowType,
      initialChain,
      initialChainType,
      amount,
      token: 'USDC',
      shieldedMetadata,
      initiatedAt: Date.now(),
    }
    
    logger.debug('[FlowInitiationService] Created flow metadata', {
      localId,
      flowType,
      initialChain,
      amount,
    })
    
    return initiationMetadata
  }

}

// Export singleton instance
export const flowInitiationService = new FlowInitiationService()


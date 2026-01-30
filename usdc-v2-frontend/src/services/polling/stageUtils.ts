/**
 * Stage Utilities
 * 
 * Helper functions for reading stages from unified structure (pollingState)
 * and legacy structures (clientStages).
 */

import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import type { ChainStage } from '@/types/flow'
import type { ChainKey } from '@/shared/flowStages'
import { getChainOrder } from '@/shared/flowStages'
import { migrateClientStagesToUnified } from './pollingStateManager'
import { transactionStorageService } from '@/services/tx/transactionStorageService'

/**
 * Get all stages from a transaction (unified format)
 * Reads from pollingState.chainStatus[chain].stages if available,
 * otherwise falls back to clientStages + flowStatusSnapshot
 * 
 * @param tx - Transaction to get stages from
 * @param flowType - Flow type ('deposit' or 'payment')
 * @returns Array of stages in chronological order
 */
export function getAllStagesFromTransaction(
  tx: StoredTransaction,
  flowType: 'deposit' | 'payment',
): ChainStage[] {
  const stages: ChainStage[] = []

  // Migrate clientStages to unified structure if needed
  let currentTx = tx
  if (currentTx.clientStages && currentTx.clientStages.length > 0 && currentTx.pollingState) {
    migrateClientStagesToUnified(currentTx.id)
    // Reload transaction after migration
    const updatedTx = transactionStorageService.getTransaction(currentTx.id)
    if (updatedTx) {
      currentTx = updatedTx
    }
  }

  // Read from unified pollingState structure if available
  if (currentTx.pollingState) {
    const chainOrder = getChainOrder(flowType)
    for (const chain of chainOrder) {
      const chainStatus = currentTx.pollingState.chainStatus[chain]
      if (chainStatus?.stages && chainStatus.stages.length > 0) {
        // Add chain information to each stage's metadata so it can be displayed correctly
        const stagesWithChain = chainStatus.stages.map((stage) => ({
          ...stage,
          metadata: {
            ...stage.metadata,
            chain, // Preserve chain information for display
          },
        }))
        stages.push(...stagesWithChain)
        
        // Debug logging removed - was causing excessive console output
        // Uncomment only when debugging stage reading issues:
        // if (process.env.NODE_ENV === 'development') {
        //   console.debug('[StageUtils] Read stages from pollingState', {
        //     chain,
        //     stageCount: chainStatus.stages.length,
        //     stageNames: chainStatus.stages.map((s) => s.stage),
        //     stagesWithOccurredAt: chainStatus.stages.filter((s) => s.occurredAt).map((s) => s.stage),
        //   })
        // }
      }
    }
  }

  // Fallback: read from clientStages (legacy)
  if (stages.length === 0 && currentTx.clientStages && currentTx.clientStages.length > 0) {
    stages.push(...currentTx.clientStages)
  }


  // Sort by occurredAt timestamp (chronological order)
  stages.sort((a, b) => {
    if (!a.occurredAt || !b.occurredAt) return 0
    return new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
  })

  return stages
}

/**
 * Get stages for a specific chain from a transaction
 * 
 * @param tx - Transaction to get stages from
 * @param chain - Chain key
 * @returns Array of stages for the chain
 */
export function getStagesForChain(
  tx: StoredTransaction,
  chain: ChainKey,
): ChainStage[] {
  const stages: ChainStage[] = []

  // Read from unified pollingState structure if available
  if (tx.pollingState) {
    const chainStatus = tx.pollingState.chainStatus[chain]
    if (chainStatus?.stages && chainStatus.stages.length > 0) {
      stages.push(...chainStatus.stages)
    }
  }

  // Fallback: read from clientStages (legacy) - filter by chain
  if (tx.clientStages && tx.clientStages.length > 0) {
    const chainStages = tx.clientStages.filter(
      (s) => (s.metadata?.chain as ChainKey) === chain,
    )
    stages.push(...chainStages)
  }


  // Sort by occurredAt timestamp
  stages.sort((a, b) => {
    if (!a.occurredAt || !b.occurredAt) return 0
    return new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
  })

  return stages
}


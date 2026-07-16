/**
 * Polling State Manager
 * 
 * Manages persistence and updates of polling state for transactions.
 * Provides utilities for finding latest completed stages and managing resume checkpoints.
 */

import type { PollingState, ChainStatus, ChainPollMetadata } from './types'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import type { ChainStage } from '@/types/flow'
import type { ChainKey, FlowStage } from '@/shared/flowStages'
import { transactionStorageService } from '@/services/tx/transactionStorageService'
import { getChainOrder, getExpectedStages, getNextStage } from '@/shared/flowStages'
import { logger } from '@/utils/logger'

/**
 * Update polling state for a transaction
 * 
 * @param txId - Transaction ID
 * @param updates - Partial polling state updates
 */
export function updatePollingState(
  txId: string,
  updates: Partial<PollingState>,
): void {
  try {
    const tx = transactionStorageService.getTransaction(txId)
    if (!tx) {
      logger.warn('[PollingStateManager] Transaction not found for polling state update', {
        txId,
      })
      return
    }

    // CRITICAL: Read current state directly from transaction to avoid circular dependency
    // Then check if migration is needed (metadata missing but exists in chainParams)
    let currentState = tx.pollingState
    
    // If metadata is missing, check if it needs migration from chainParams
    if (currentState && !currentState.metadata) {
      const initialChain = tx.direction === 'deposit' ? 'evm' : 'namada'
      const initialChainMetadata = (currentState.chainParams as any)?.[initialChain]?.metadata
      
      if (initialChainMetadata && Object.keys(initialChainMetadata).length > 0) {
        // Metadata exists in old structure - migrate it
        const allMetadata: ChainPollMetadata = { ...initialChainMetadata }
        
        // Merge metadata from other chains
        for (const chainKey in currentState.chainParams) {
          const chain = chainKey as ChainKey
          const chainParams = (currentState.chainParams as any)[chain]
          if (chainParams?.metadata && chain !== initialChain) {
            Object.assign(allMetadata, chainParams.metadata)
          }
        }
        
        // Add metadata to currentState (don't save yet - will be saved below)
        currentState = {
          ...currentState,
          metadata: allMetadata,
        }
      }
    }
    
    // CRITICAL: Preserve metadata BEFORE spreading updates
    // This ensures metadata is never lost when updating other fields
    const preservedMetadata = updates.metadata !== undefined
      ? {
          ...(currentState?.metadata || {}),
          ...updates.metadata,
        }
      : currentState?.metadata
    
    const updatedState: PollingState = {
      ...currentState,
      ...updates,
      lastUpdatedAt: Date.now(),
      // Preserve required fields if creating new state
      flowStatus: updates.flowStatus ?? currentState?.flowStatus ?? 'pending',
      flowType: updates.flowType ?? currentState?.flowType ?? (tx.direction === 'deposit' ? 'deposit' : 'payment'),
      startedAt: updates.startedAt ?? currentState?.startedAt ?? Date.now(),
      chainStatus: {
        ...currentState?.chainStatus,
        ...updates.chainStatus,
      },
      // CRITICAL: Explicitly set metadata to ensure it's preserved
      // This overrides any metadata: undefined that might be in updates
      metadata: preservedMetadata,
      // Merge chainParams (for poller config only - no metadata field)
      // If updates.chainParams is provided, merge it with current chainParams
      // If updates.chainParams is undefined, preserve current chainParams
      chainParams: updates.chainParams !== undefined
        ? (() => {
            // Start with all current chainParams to preserve chains not being updated
            const merged: PollingState['chainParams'] = {
              ...(currentState?.chainParams || {}),
            }
            
            // CRITICAL: If updates.chainParams is empty object {}, don't overwrite existing chainParams
            // This prevents accidental clearing of chainParams when empty object is passed
            const updateKeys = Object.keys(updates.chainParams)
            if (updateKeys.length === 0 && Object.keys(merged).length > 0) {
              // Empty update but we have existing chainParams - preserve them
              return merged
            }
            
            // Process each chain in updates.chainParams and merge (no metadata field)
            for (const chainKey in updates.chainParams) {
              const chain = chainKey as keyof typeof updates.chainParams
              const currentChainParams = currentState?.chainParams?.[chain]
              const updatedChainParams = updates.chainParams[chain]
              
              if (updatedChainParams) {
                // Merge chainParams (no metadata field - metadata is in pollingState.metadata)
                merged[chain] = {
                  ...currentChainParams,
                  ...updatedChainParams,
                } as any
              }
            }
            
            return merged
          })()
        : (currentState?.chainParams || {}),
    }

    transactionStorageService.updateTransaction(txId, {
      pollingState: updatedState,
    })

    logger.debug('[PollingStateManager] Updated polling state', {
      txId,
      updates: Object.keys(updates),
    })
  } catch (error) {
    logger.error('[PollingStateManager] Failed to update polling state', {
      txId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Update chain status for a specific chain
 * 
 * @param txId - Transaction ID
 * @param chain - Chain key
 * @param status - Chain status updates
 */
export function updateChainStatus(
  txId: string,
  chain: ChainKey,
  status: Partial<ChainStatus>,
): void {
  try {
    const tx = transactionStorageService.getTransaction(txId)
    if (!tx || !tx.pollingState) {
      logger.warn('[PollingStateManager] Transaction or polling state not found', {
        txId,
        chain,
      })
      return
    }

    const currentChainStatus = tx.pollingState.chainStatus[chain] ?? {
      status: 'pending',
      completedStages: [],
    }

    // Deduplication: Only update errorMessage if it's different from current
    // This prevents duplicate error messages from being set
    let errorMessage = status.errorMessage
    if (errorMessage !== undefined && errorMessage === currentChainStatus.errorMessage) {
      // Same error message - don't update (avoid duplicate)
      errorMessage = currentChainStatus.errorMessage
    }

    const updatedChainStatus: ChainStatus = {
      ...currentChainStatus,
      ...status,
      // Use deduplicated error message
      errorMessage: errorMessage ?? currentChainStatus.errorMessage,
      // Preserve completed stages array
      completedStages: status.completedStages ?? currentChainStatus.completedStages,
      // Preserve stages array
      stages: status.stages ?? currentChainStatus.stages,
      // Preserve retry count if not explicitly updated
      retryCount: status.retryCount ?? currentChainStatus.retryCount,
      // Preserve error code if not explicitly updated
      errorCode: status.errorCode ?? currentChainStatus.errorCode,
    }

    updatePollingState(txId, {
      chainStatus: {
        ...tx.pollingState.chainStatus,
        [chain]: updatedChainStatus,
      },
    })

    logger.debug('[PollingStateManager] Updated chain status', {
      txId,
      chain,
      status: updatedChainStatus.status,
    })
  } catch (error) {
    logger.error('[PollingStateManager] Failed to update chain status', {
      txId,
      chain,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Find the latest completed stage across all chains
 * 
 * @param tx - Transaction with polling state
 * @returns Latest completed stage identifier, or undefined if none
 */
export function findLatestCompletedStage(tx: StoredTransaction): string | undefined {
  if (!tx.pollingState) {
    return undefined
  }

  const { chainStatus, flowType } = tx.pollingState
  const chainOrder = getChainOrder(flowType)

  // Iterate through chains in reverse order (most recent first)
  for (let i = chainOrder.length - 1; i >= 0; i--) {
    const chain = chainOrder[i]
    const status = chainStatus[chain]

    if (status?.completedStages && status.completedStages.length > 0) {
      // Return the last completed stage for this chain
      return status.completedStages[status.completedStages.length - 1]
    }
  }

  return undefined
}

/**
 * Determine the next expected stage to poll
 * 
 * @param tx - Transaction with polling state
 * @returns Next expected stage and chain, or undefined if flow is complete
 */
export function determineNextStage(
  tx: StoredTransaction,
): { stage: string; chain: ChainKey } | undefined {
  if (!tx.pollingState) {
    return undefined
  }

  const { flowType } = tx.pollingState
  const chainOrder = getChainOrder(flowType)

  // Find latest completed stage
  const latestStage = findLatestCompletedStage(tx)
  if (!latestStage) {
    // No stages completed yet, start with first chain
    const firstChain = chainOrder[0]
    const expectedStages = getExpectedStages(flowType, firstChain)
    if (expectedStages.length > 0) {
      return {
        stage: expectedStages[0],
        chain: firstChain,
      }
    }
    return undefined
  }

  // Find which chain the latest stage belongs to
  let latestChain: ChainKey | undefined
  for (const chain of chainOrder) {
    const expectedStages = getExpectedStages(flowType, chain)
    if (expectedStages.includes(latestStage as FlowStage)) {
      latestChain = chain
      break
    }
  }

  if (!latestChain) {
    logger.warn('[PollingStateManager] Could not determine chain for latest stage', {
      txId: tx.id,
      latestStage,
    })
    return undefined
  }

  // Check if there's a next stage in the same chain
  const nextStage = getNextStage(latestStage as FlowStage, flowType, latestChain)
  if (nextStage) {
    return {
      stage: nextStage,
      chain: latestChain,
    }
  }

  // No more stages in current chain, move to next chain
  const currentChainIndex = chainOrder.indexOf(latestChain)
  if (currentChainIndex < chainOrder.length - 1) {
    const nextChain = chainOrder[currentChainIndex + 1]
    const expectedStages = getExpectedStages(flowType, nextChain)
    if (expectedStages.length > 0) {
      return {
        stage: expectedStages[0],
        chain: nextChain,
      }
    }
  }

  // Flow is complete
  return undefined
}

/**
 * Get polling state for a transaction
 * 
 * @param txId - Transaction ID
 * @returns Polling state or undefined
 */
export function getPollingState(txId: string): PollingState | undefined {
  const tx = transactionStorageService.getTransaction(txId)
  if (!tx?.pollingState) {
    return undefined
  }
  
  const state = tx.pollingState
  
  // Migration: If metadata exists in chainParams but not in pollingState.metadata, migrate it
  if (!state.metadata) {
    const initialChain = tx.direction === 'deposit' ? 'evm' : 'namada'
    const initialChainMetadata = (state.chainParams as any)?.[initialChain]?.metadata
    
    if (initialChainMetadata && Object.keys(initialChainMetadata).length > 0) {
      logger.info('[PollingStateManager] Migrating metadata from chainParams to pollingState.metadata', {
        txId,
        initialChain,
        metadataKeys: Object.keys(initialChainMetadata),
      })
      
      // Collect metadata from all chains (initial chain has initial metadata, others have result metadata)
      const allMetadata: ChainPollMetadata = { ...initialChainMetadata }
      
      // Merge metadata from other chains (for result metadata like cctpNonce, packetSequence)
      for (const chainKey in state.chainParams) {
        const chain = chainKey as ChainKey
        const chainParams = (state.chainParams as any)[chain]
        if (chainParams?.metadata && chain !== initialChain) {
          Object.assign(allMetadata, chainParams.metadata)
        }
      }
      
      // Update state with migrated metadata
      const migratedState: PollingState = {
        ...state,
        metadata: allMetadata,
      }
      
      // Remove metadata from chainParams (clean up old structure)
      const cleanedChainParams: typeof state.chainParams = {}
      for (const chainKey in state.chainParams) {
        const chain = chainKey as ChainKey
        const chainParams = (state.chainParams as any)[chain]
        if (chainParams) {
          const { metadata, ...rest } = chainParams
          cleanedChainParams[chain] = rest as any
        }
      }
      
      migratedState.chainParams = cleanedChainParams
      
      // Save migrated state
      transactionStorageService.updateTransaction(txId, {
        pollingState: migratedState,
      })
      
      return migratedState
    }
  }
  
  return state
}

/**
 * Initialize polling state for a new transaction
 * 
 * @param txId - Transaction ID
 * @param flowType - Flow type
 * @param initialMetadata - Initial metadata for first chain
 */
export function initializePollingState(
  txId: string,
  flowType: 'deposit' | 'payment',
  initialMetadata?: Record<string, unknown>,
): void {
  const initialState: PollingState = {
    flowStatus: 'pending',
    chainStatus: {},
    flowType,
    chainParams: {},
    metadata: initialMetadata ? (initialMetadata as ChainPollMetadata) : undefined,
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  }

  updatePollingState(txId, initialState)
}

/**
 * Merge stages intelligently: check if stage exists and overwrite instead of duplicating
 * Preserves original timestamp but updates status/metadata if changed
 * 
 * @param existingStages - Existing stages for the chain
 * @param newStages - New stages to merge (can be single stage or array)
 * @returns Merged stages array without duplicates
 */
export function mergeStagesIntelligently(
  existingStages: ChainStage[],
  newStages: ChainStage | ChainStage[],
): ChainStage[] {
  const stagesToMerge = Array.isArray(newStages) ? newStages : [newStages]
  const merged: ChainStage[] = [...existingStages]
  
  for (const newStage of stagesToMerge) {
    // Find existing stage with same name
    const existingIndex = merged.findIndex((s) => s.stage === newStage.stage)
    
    if (existingIndex >= 0) {
      // Stage exists - update in place but preserve original timestamp
      const existingStage = merged[existingIndex]
      
      // Filter out undefined values from newStage to avoid overwriting with undefined
      const filteredNewStage: Partial<ChainStage> = {}
      for (const key in newStage) {
        const value = (newStage as any)[key]
        if (value !== undefined) {
          filteredNewStage[key as keyof ChainStage] = value
        }
      }
      
      merged[existingIndex] = {
        ...existingStage,
        ...filteredNewStage,
        // Preserve original timestamp (first occurrence)
        occurredAt: existingStage.occurredAt || newStage.occurredAt,
        // Update status if provided (e.g., pending -> confirmed)
        status: filteredNewStage.status ?? existingStage.status,
        // Merge metadata (existing preserved, new merged in)
        metadata: {
          ...existingStage.metadata,
          ...filteredNewStage.metadata,
        },
        // Preserve other fields if not explicitly updated
        txHash: filteredNewStage.txHash ?? existingStage.txHash,
        source: filteredNewStage.source ?? existingStage.source,
        message: filteredNewStage.message ?? existingStage.message,
      }
    } else {
      // New stage - add it
      merged.push(newStage)
    }
  }
  
  return merged
}

/**
 * Add a stage to a chain's stages array (unified storage)
 * 
 * @param txId - Transaction ID
 * @param chain - Chain key
 * @param stage - Stage to add
 */
export function addChainStage(txId: string, chain: ChainKey, stage: ChainStage): void {
  try {
    // Read fresh state to avoid race conditions
    const tx = transactionStorageService.getTransaction(txId)
    if (!tx || !tx.pollingState) {
      logger.warn('[PollingStateManager] Transaction or polling state not found for adding stage', {
        txId,
        chain,
      })
      return
    }

    const currentChainStatus = tx.pollingState.chainStatus[chain] ?? {
      status: 'pending',
      completedStages: [],
      stages: [],
    }

    const existingStages = currentChainStatus.stages || []
    // Use intelligent merging to avoid duplicates
    const updatedStages = mergeStagesIntelligently(existingStages, stage)

    updateChainStatus(txId, chain, {
      stages: updatedStages,
    })

    logger.debug('[PollingStateManager] Added stage to chain', {
      txId,
      chain,
      stage: stage.stage,
      totalStages: updatedStages.length,
      wasNew: !existingStages.some((s) => s.stage === stage.stage),
    })
  } catch (error) {
    logger.error('[PollingStateManager] Failed to add chain stage', {
      txId,
      chain,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Update chain stage incrementally during polling
 * This function is designed for pollers to update stages as they complete,
 * ensuring stages appear in the event log immediately rather than waiting for polling completion.
 * 
 * Features:
 * - Uses intelligent merging to avoid duplicates
 * - Updates completedStages array when status is 'confirmed'
 * - Updates latestCompletedStage in polling state if applicable
 * - Handles metadata updates safely (preserves existing, merges new)
 * 
 * @param txId - Transaction ID
 * @param chain - Chain key
 * @param stage - Stage to update/add
 */
export function updateChainStageIncremental(
  txId: string,
  chain: ChainKey,
  stage: ChainStage,
): void {
  try {
    // Read fresh state to avoid race conditions
    const tx = transactionStorageService.getTransaction(txId)
    if (!tx || !tx.pollingState) {
      logger.warn('[PollingStateManager] Transaction or polling state not found for incremental stage update', {
        txId,
        chain,
        stage: stage.stage,
      })
      return
    }

    const currentChainStatus = tx.pollingState.chainStatus[chain] ?? {
      status: 'pending',
      completedStages: [],
      stages: [],
    }

    const existingStages = currentChainStatus.stages || []
    
    // Check if this is an update to an existing stage or a new stage
    const existingStageIndex = existingStages.findIndex((s) => s.stage === stage.stage)
    const isNewStage = existingStageIndex < 0
    
    // Merge stages intelligently
    const updatedStages = mergeStagesIntelligently(existingStages, stage)
    
    // Update completedStages array if status is 'confirmed'
    let updatedCompletedStages = [...(currentChainStatus.completedStages || [])]
    if (stage.status === 'confirmed' && !updatedCompletedStages.includes(stage.stage)) {
      updatedCompletedStages.push(stage.stage)
    }
    
    // Update chain status with merged stages
    updateChainStatus(txId, chain, {
      stages: updatedStages,
      completedStages: updatedCompletedStages.length > 0 ? updatedCompletedStages : undefined,
    })
    
    // Update latestCompletedStage in polling state if this is a confirmed stage
    if (stage.status === 'confirmed') {
      updatePollingState(txId, {
        latestCompletedStage: stage.stage,
      })
    }
    
    logger.debug('[PollingStateManager] Updated chain stage incrementally', {
      txId,
      chain,
      stage: stage.stage,
      status: stage.status,
      isNewStage,
      totalStages: updatedStages.length,
      completedStagesCount: updatedCompletedStages.length,
    })
  } catch (error) {
    logger.error('[PollingStateManager] Failed to update chain stage incrementally', {
      txId,
      chain,
      stage: stage.stage,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Migrate clientStages to unified pollingState structure
 * 
 * @param txId - Transaction ID
 */
export function migrateClientStagesToUnified(txId: string): void {
  try {
    const tx = transactionStorageService.getTransaction(txId)
    if (!tx || !tx.clientStages || tx.clientStages.length === 0) {
      return
    }

    // Initialize polling state if it doesn't exist
    if (!tx.pollingState) {
      const flowType = tx.direction === 'deposit' ? 'deposit' : 'payment'
      initializePollingState(txId, flowType)
    }

    // Migrate each client stage to the appropriate chain
    for (const clientStage of tx.clientStages) {
      const chain = (clientStage.metadata?.chain as ChainKey) || 'evm'
      addChainStage(txId, chain, clientStage)
    }

    // Remove clientStages field after migration
    transactionStorageService.updateTransaction(txId, {
      clientStages: undefined,
    })

    logger.info('[PollingStateManager] Migrated clientStages to unified structure', {
      txId,
      migratedCount: tx.clientStages.length,
    })
  } catch (error) {
    logger.error('[PollingStateManager] Failed to migrate clientStages', {
      txId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}


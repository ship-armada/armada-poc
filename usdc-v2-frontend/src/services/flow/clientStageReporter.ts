import type { ClientStageInput, ChainStage } from '@/types/flow'
import { transactionStorageService } from '@/services/tx/transactionStorageService'
import {
  addChainStage,
  migrateClientStagesToUnified,
  updateChainStatus,
} from '@/services/polling/pollingStateManager'
import { logger } from '@/utils/logger'
import type { ChainKey } from '@/shared/flowStages'

/**
 * Service for storing client-side stages locally.
 * Used for stages that occur client-side (gasless swaps, wallet interactions)
 * that occur before backend registration or are ephemeral.
 * 
 * Stages are stored in the transaction's `clientStages` array and prepended
 * when displaying transaction status.
 */
class ClientStageReporter {
  /**
   * Store a client-side stage locally in the transaction.
   * 
   * @param identifier - Transaction ID, localId, or flowId
   * @param chain - Chain where stage occurred
   * @param stage - Stage identifier
   * @param details - Additional stage details
   */
  async reportStage(
    identifier: string,
    chain: 'evm' | 'noble' | 'namada',
    stage: string,
    details: Partial<ClientStageInput> = {},
  ): Promise<void> {
    try {
      // Find transaction by ID, localId, or flowId
      const tx = this.findTransaction(identifier)
      if (!tx) {
        logger.warn('[ClientStageReporter] Cannot store stage, transaction not found', {
          identifier,
          chain,
          stage,
        })
        return
      }

      // Create stage object
      const clientStage: ChainStage = {
        stage,
        source: 'client',
        occurredAt: new Date().toISOString(),
        status: details.status || 'pending',
        message: details.message,
        txHash: details.txHash,
        metadata: {
          ...details.metadata,
          chain, // Store chain in metadata for display purposes
        },
      }

      // Use unified pollingState structure (always enabled now)
      if (tx.pollingState) {
        // Add stage to unified pollingState structure
        addChainStage(tx.id, chain as ChainKey, clientStage)
      } else {
        // Migrate existing clientStages if pollingState exists but clientStages also exist
        if (tx.clientStages && tx.clientStages.length > 0) {
          migrateClientStagesToUnified(tx.id)
          // Re-add the new stage after migration
          addChainStage(tx.id, chain as ChainKey, clientStage)
        } else {
          // Append to clientStages array (legacy path for transactions without pollingState)
          const existingStages = tx.clientStages || []
          const updatedStages = [...existingStages, clientStage]

          // Update transaction with new stage
          transactionStorageService.updateTransaction(tx.id, {
            clientStages: updatedStages,
          })
        }
      }

      // Calculate total stages for logging
      let totalStages = 0
      if (tx.pollingState) {
        // Count stages from unified structure
        totalStages = Object.values(tx.pollingState.chainStatus)
          .flatMap((cs) => cs?.stages || [])
          .filter((s) => s.source === 'client').length
      } else {
        // Count stages from clientStages (legacy)
        const currentTx = transactionStorageService.getTransaction(tx.id)
        totalStages = currentTx?.clientStages?.length || 0
      }

      logger.debug('[ClientStageReporter] Stored client stage locally', {
        txId: tx.id,
        chain,
        stage,
        totalStages,
      })
    } catch (error) {
      // Don't throw - client stage reporting is non-blocking
      logger.warn('[ClientStageReporter] Failed to store stage', {
        identifier,
        chain,
        stage,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Store a gasless swap stage locally.
   * 
   * @param identifier - Transaction ID, localId, or flowId
   * @param stage - Gasless stage identifier (e.g., 'gasless_quote_pending', 'gasless_swap_completed')
   * @param txHash - Optional transaction hash
   * @param status - Stage status
   */
  async reportGaslessStage(
    identifier: string,
    stage: string,
    txHash?: string,
    status?: 'pending' | 'confirmed' | 'failed',
  ): Promise<void> {
    await this.reportStage(identifier, 'evm', stage, {
      kind: 'gasless',
      txHash,
      status,
    })
  }

  /**
   * Store a wallet interaction stage locally.
   * 
   * @param identifier - Transaction ID, localId, or flowId
   * @param stage - Wallet stage identifier (e.g., 'wallet_signing', 'wallet_broadcasting')
   * @param chain - Chain where interaction occurred
   * @param txHash - Optional transaction hash
   * @param status - Stage status
   */
  async reportWalletStage(
    identifier: string,
    stage: string,
    chain: 'evm' | 'noble' | 'namada',
    txHash?: string,
    status?: 'pending' | 'confirmed' | 'failed',
  ): Promise<void> {
    await this.reportStage(identifier, chain, stage, {
      txHash,
      status,
    })
  }

  /**
   * Update an existing client stage's status.
   * Used to mark stages as 'confirmed' when they complete.
   * 
   * @param identifier - Transaction ID, localId, or flowId
   * @param stage - Stage identifier to update
   * @param status - New status for the stage
   */
  async updateStageStatus(
    identifier: string,
    stage: string,
    status: 'pending' | 'confirmed' | 'failed',
  ): Promise<void> {
    try {
      let tx = this.findTransaction(identifier)
      if (!tx) {
        logger.warn('[ClientStageReporter] Cannot update stage, transaction not found', {
          identifier,
          stage,
          status,
        })
        return
      }

      // Migrate clientStages to unified structure if needed
      if (tx.clientStages && tx.clientStages.length > 0 && tx.pollingState) {
        migrateClientStagesToUnified(tx.id)
        // Reload transaction after migration
        const updatedTx = transactionStorageService.getTransaction(tx.id)
        if (!updatedTx) {
          return
        }
        tx = updatedTx
      }

      // Use unified pollingState structure (always enabled now)
      if (tx.pollingState) {
        // Find and update stage in unified structure
        const chainOrder: ChainKey[] = ['evm', 'noble', 'namada']
        for (const chain of chainOrder) {
          const chainStatus = tx.pollingState.chainStatus[chain]
          const stages = chainStatus?.stages || []
          const stageIndex = stages.findIndex((s) => s.stage === stage && s.source === 'client')

          if (stageIndex >= 0) {
            const updatedStages = [...stages]
            updatedStages[stageIndex] = {
              ...updatedStages[stageIndex],
              status,
            }

            updateChainStatus(tx.id, chain, {
              stages: updatedStages,
            })

            logger.debug('[ClientStageReporter] Updated client stage status in unified structure', {
              txId: tx.id,
              chain,
              stage,
              status,
            })
            return
          }
        }

        logger.warn('[ClientStageReporter] Stage not found in unified structure', {
          identifier,
          stage,
          availableStages: Object.values(tx.pollingState.chainStatus)
            .flatMap((cs) => cs?.stages?.map((s) => s.stage) || []),
        })
        return
      }

      // Fallback to clientStages (legacy path)
      if (!tx.clientStages || tx.clientStages.length === 0) {
        logger.warn('[ClientStageReporter] Cannot update stage, no stages found', {
          identifier,
          stage,
          status,
        })
        return
      }

      // Find and update the stage
      const updatedStages = tx.clientStages.map((s) => {
        if (s.stage === stage) {
          return { ...s, status }
        }
        return s
      })

      // Check if stage was found and updated
      const stageFound = updatedStages.some((s) => s.stage === stage && s.status === status)
      if (!stageFound) {
        logger.warn('[ClientStageReporter] Stage not found for update', {
          identifier,
          stage,
          availableStages: tx.clientStages.map((s) => s.stage),
        })
        return
      }

      // Update transaction with updated stages
      transactionStorageService.updateTransaction(tx.id, {
        clientStages: updatedStages,
      })

      logger.debug('[ClientStageReporter] Updated client stage status', {
        txId: tx.id,
        stage,
        status,
      })
    } catch (error) {
      // Don't throw - stage status update is non-blocking
      logger.warn('[ClientStageReporter] Failed to update stage status', {
        identifier,
        stage,
        status,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Find transaction by ID, localId, or flowId.
   * 
   * @param identifier - Transaction ID, localId, or flowId
   * @returns Transaction if found, null otherwise
   */
  private findTransaction(identifier: string) {
    // Try as transaction ID first
    let tx = transactionStorageService.getTransaction(identifier)
    if (tx) {
      return tx
    }

    // Try as localId (look up transaction by flowMetadata.localId)
    tx = transactionStorageService.getTransactionByLocalId(identifier)
    if (tx) {
      return tx
    }

    return null
  }
}

// Export singleton instance
export const clientStageReporter = new ClientStageReporter()


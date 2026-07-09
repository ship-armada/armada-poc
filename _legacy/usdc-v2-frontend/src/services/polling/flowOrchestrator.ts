/**
 * Flow Orchestrator
 * 
 * Manages the lifecycle of a single transaction flow, orchestrating chain polling jobs
 * in the correct order and handling metadata passing between chains.
 * 
 * Each flow gets its own orchestrator instance for complete encapsulation.
 */

import type {
  ChainPollMetadata,
  ChainStatus,
  ChainStatusValue,
} from './types'
import type { ChainKey, FlowType } from '@/shared/flowStages'
import {
  getChainOrder,
  getChainForStage,
  type FlowStage,
  DEPOSIT_STAGES,
} from '@/shared/flowStages'
import {
  updatePollingState,
  updateChainStatus,
  getPollingState,
  mergeStagesIntelligently,
} from './pollingStateManager'
import { getChainTimeout, calculateGlobalTimeout } from './timeoutConfig'
import { createEvmPoller } from './evmPoller'
import { createNamadaPoller } from './namadaPoller'
import { getStartHeightFromTimestamp } from './blockHeightLookup'
import type { ChainPoller, ChainPollParams, ChainPollResult } from './types'

// Stub Noble poller - Noble chain support has been removed
function createNoblePoller(): ChainPoller {
  return {
    poll: async (_params: ChainPollParams): Promise<ChainPollResult> => {
      return {
        success: false,
        found: false,
        stages: [],
        metadata: {},
        error: {
          type: 'polling_error',
          message: 'Noble chain support has been removed from this version',
          isRecoverable: false,
          occurredAt: Date.now(),
        },
      }
    },
  }
}

// Stub Noble forwarding registration - Noble chain support has been removed
async function executeRegistrationJob(_params: {
  txId: string
  forwardingAddress: string
  recipientAddress: string
  channelId?: string
  fallback?: string
  abortSignal: AbortSignal
}): Promise<{
  success: false
  alreadyRegistered: false
  registrationTx: { txHash: string }
  metadata: { errorMessage: string }
}> {
  return {
    success: false,
    alreadyRegistered: false,
    registrationTx: { txHash: '' },
    metadata: { errorMessage: 'Noble chain support has been removed from this version' },
  }
}
import { logger } from '@/utils/logger'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { transactionStorageService } from '@/services/tx/transactionStorageService'

/**
 * Flow Orchestrator Options
 */
export interface FlowOrchestratorOptions {
  /** Transaction ID */
  txId: string
  /** Flow type */
  flowType: FlowType
  /** Initial metadata for first chain */
  initialMetadata?: Record<string, unknown>
  /** Transaction object (for accessing existing state) */
  transaction?: StoredTransaction
}

/**
 * Flow Orchestrator Class
 * 
 * Manages the lifecycle of a single transaction flow.
 * Each instance is completely isolated from other flows.
 */
export class FlowOrchestrator {
  private readonly txId: string
  private readonly flowType: FlowType
  private readonly abortController: AbortController
  private readonly pollers: Map<ChainKey, ChainPoller>
  private isRunning: boolean = false
  private globalTimeoutTimer: NodeJS.Timeout | null = null

  constructor(options: FlowOrchestratorOptions) {
    this.txId = options.txId
    this.flowType = options.flowType
    this.abortController = new AbortController()

    // Initialize chain pollers (interface-based, modular)
    this.pollers = new Map([
      ['evm', createEvmPoller()],
      ['noble', createNoblePoller()],
      ['namada', createNamadaPoller()],
    ])

    // Initialize polling state if not exists
    const existingState = options.transaction?.pollingState
    if (!existingState) {
      this.initializePollingState(options.initialMetadata)
    }
  }

  /**
   * Initialize polling state for new flow
   */
  private initializePollingState(initialMetadata?: Record<string, unknown>): void {
    const initialChain = this.flowType === 'deposit' ? 'evm' : 'namada'
    
    logger.info('[FlowOrchestrator] Initializing polling state with initial metadata', {
      txId: this.txId,
      flowType: this.flowType,
      initialChain,
      hasInitialMetadata: !!initialMetadata,
      initialMetadataKeys: initialMetadata ? Object.keys(initialMetadata) : [],
      initialMetadataFields: initialMetadata ? {
        expectedAmountUusdc: 'expectedAmountUusdc' in initialMetadata,
        namadaReceiver: 'namadaReceiver' in initialMetadata,
        forwardingAddress: 'forwardingAddress' in initialMetadata,
      } : {},
      fullInitialMetadata: initialMetadata,
    })
    
    // Store initial metadata in top-level metadata field (single source of truth)
    updatePollingState(this.txId, {
      flowStatus: 'pending',
      chainStatus: {},
      flowType: this.flowType,
      chainParams: {},
      metadata: initialMetadata ? (initialMetadata as ChainPollMetadata) : undefined,
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    })
    
    // Verify it was stored correctly
    const verifyState = getPollingState(this.txId)
    logger.info('[FlowOrchestrator] Verified initial metadata storage', {
      txId: this.txId,
      hasMetadata: !!verifyState?.metadata,
      storedMetadataKeys: verifyState?.metadata ? Object.keys(verifyState.metadata) : [],
      storedMetadataHasInitialFields: verifyState?.metadata ? {
        expectedAmountUusdc: 'expectedAmountUusdc' in verifyState.metadata,
        namadaReceiver: 'namadaReceiver' in verifyState.metadata,
        forwardingAddress: 'forwardingAddress' in verifyState.metadata,
      } : {},
    })
  }

  /**
   * Get abort signal for polling jobs
   */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal
  }

  /**
   * Cancel flow (immediately halt all polling jobs)
   */
  cancelFlow(): void {
    if (this.abortController.signal.aborted) {
      logger.debug('[FlowOrchestrator] Flow already cancelled', {
        txId: this.txId,
      })
      return
    }

    logger.info('[FlowOrchestrator] Cancelling flow - aborting controller', {
      txId: this.txId,
      flowType: this.flowType,
      currentChain: getPollingState(this.txId)?.currentChain,
    })

    // Abort the controller - this will propagate to all pollers via abortSignal
    this.abortController.abort()

    logger.debug('[FlowOrchestrator] AbortController aborted', {
      txId: this.txId,
      signalAborted: this.abortController.signal.aborted,
    })

    // Update flow status to cancelled
    updatePollingState(this.txId, {
      flowStatus: 'cancelled',
    })

    // Update current chain status to cancelled if exists
    const state = getPollingState(this.txId)
    if (state?.currentChain) {
      logger.info('[FlowOrchestrator] Updating current chain status to cancelled', {
        txId: this.txId,
        chain: state.currentChain,
      })
      updateChainStatus(this.txId, state.currentChain, {
        status: 'cancelled',
      })
    }
  }

  /**
   * Start entire flow from beginning
   */
  async startFlow(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[FlowOrchestrator] Flow already running', {
        txId: this.txId,
      })
      return
    }

    this.isRunning = true
    logger.info('[FlowOrchestrator] Starting flow from beginning', {
      txId: this.txId,
      flowType: this.flowType,
    })

    try {
      // Get current state to preserve metadata
      const currentState = getPollingState(this.txId)
      
      // Check if metadata exists, if not, try to restore from transaction details
      // (This can happen if startFlow is called before initializePollingState, or if state was reset)
      if (!currentState?.metadata || Object.keys(currentState.metadata).length === 0) {
        logger.warn('[FlowOrchestrator] Metadata missing, attempting to restore from transaction', {
          txId: this.txId,
          hasMetadata: !!currentState?.metadata,
        })
        
        // Try to get initial metadata from transaction details as fallback
        const tx = transactionStorageService.getTransaction(this.txId)
        if (tx && this.flowType === 'deposit' && tx.depositDetails) {
          const details = tx.depositDetails
          const amountInBaseUnits = Math.round(parseFloat(details.amount) * 1_000_000).toString()
          const expectedAmountUusdc = `${amountInBaseUnits}uusdc`
          const chainKey = tx.chain || details.chainName.toLowerCase().replace(/\s+/g, '-')
          
          const restoredMetadata: ChainPollMetadata = {
            chainKey,
            txHash: tx.hash,
            recipient: tx.depositData?.nobleForwardingAddress || details.destinationAddress,
            amountBaseUnits: amountInBaseUnits,
            usdcAddress: tx.depositData?.usdcAddress,
            messageTransmitterAddress: tx.depositData?.messageTransmitterAddress,
            namadaReceiver: details.destinationAddress,
            expectedAmountUusdc,
            forwardingAddress: tx.depositData?.nobleForwardingAddress,
            fallback: tx.depositData?.fallback,
            flowType: this.flowType,
          }
          
          updatePollingState(this.txId, {
            metadata: restoredMetadata,
          })
          
          logger.info('[FlowOrchestrator] Restored initial metadata from transaction', {
            txId: this.txId,
            restoredMetadataKeys: Object.keys(restoredMetadata),
          })
        }
      }
      
      // Reset polling state but preserve metadata (single source of truth)
      updatePollingState(this.txId, {
        flowStatus: 'pending',
        chainStatus: {},
        latestCompletedStage: undefined,
        currentChain: undefined,
        startedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        // Preserve metadata and chainParams (for poller config)
      })
      
      // Verify metadata is preserved
      const verifyState = getPollingState(this.txId)
      logger.info('[FlowOrchestrator] Verified metadata after startFlow', {
        txId: this.txId,
        hasMetadata: !!verifyState?.metadata,
        storedMetadataKeys: verifyState?.metadata ? Object.keys(verifyState.metadata) : [],
        storedMetadataHasInitialFields: verifyState?.metadata ? {
          expectedAmountUusdc: 'expectedAmountUusdc' in verifyState.metadata,
          namadaReceiver: 'namadaReceiver' in verifyState.metadata,
          forwardingAddress: 'forwardingAddress' in verifyState.metadata,
        } : {},
      })

      // Start from first chain
      await this.executeFlow()
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Resume flow from latest completed stage
   */
  async resumeFlow(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[FlowOrchestrator] Flow already running', {
        txId: this.txId,
      })
      return
    }

    this.isRunning = true
    logger.info('[FlowOrchestrator] Resuming flow', {
      txId: this.txId,
      flowType: this.flowType,
    })

    try {
      const state = getPollingState(this.txId)
      if (!state) {
        logger.warn('[FlowOrchestrator] No polling state found, starting fresh', {
          txId: this.txId,
        })
        await this.startFlow()
        return
      }

      // Update status to pending if it was cancelled
      if (state.flowStatus === 'cancelled') {
        updatePollingState(this.txId, {
          flowStatus: 'pending',
        })
      }

      // Resume from where we left off
      await this.executeFlow()
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Start single chain job in isolation
   */
  async startChainJob(chain: ChainKey, options?: { resume?: boolean }): Promise<void> {
    if (this.isRunning) {
      logger.warn('[FlowOrchestrator] Flow already running', {
        txId: this.txId,
        chain,
      })
      return
    }

    this.isRunning = true
    logger.info('[FlowOrchestrator] Starting single chain job', {
      txId: this.txId,
      chain,
      resume: options?.resume,
    })

    try {
      await this.executeChainJob(chain, options?.resume)
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Execute entire flow (from current position or beginning)
   */
  private async executeFlow(): Promise<void> {
    const chainOrder = getChainOrder(this.flowType)
    const state = getPollingState(this.txId)

    // Determine starting chain based on latest completed stage
    let startIndex = 0
    if (state?.latestCompletedStage) {
      const latestStage = state.latestCompletedStage
      const latestChain = getChainForStage(latestStage as FlowStage, this.flowType)

      if (latestChain) {
        const latestIndex = chainOrder.indexOf(latestChain)
        // Start from next chain if current chain is complete
        const isChainComplete = state.chainStatus[latestChain]?.status === 'success'

        if (isChainComplete && latestIndex < chainOrder.length - 1) {
          startIndex = latestIndex + 1
        } else {
          // Resume current chain if not complete
          startIndex = latestIndex
        }
      }
    }

    // Set up global timeout
    await this.setupGlobalTimeout(chainOrder)

    // Execute chains in order
    for (let i = startIndex; i < chainOrder.length; i++) {
      if (this.abortController.signal.aborted) {
        logger.info('[FlowOrchestrator] Flow aborted, stopping execution', {
          txId: this.txId,
        })
        // Clear global timeout timer
        if (this.globalTimeoutTimer) {
          clearTimeout(this.globalTimeoutTimer)
          this.globalTimeoutTimer = null
        }
        break
      }

      const chain = chainOrder[i]
      await this.executeChainJob(chain, true)

      // CRITICAL: Read fresh state after chain job completes to ensure we have latest metadata
      // This is especially important when moving to the next chain, as the previous chain
      // may have updated metadata that we need for prerequisites
      const currentState = getPollingState(this.txId)
      const chainStatus = currentState?.chainStatus[chain]
      
      if (
        chainStatus?.status === 'polling_timeout' ||
        chainStatus?.status === 'polling_error' ||
        chainStatus?.status === 'user_action_required'
      ) {
        // user_action_required - attempt automatic retry for Noble forwarding registration
        if (chainStatus.status === 'user_action_required' && chain === 'noble') {
          logger.info('[FlowOrchestrator] Noble requires user action - attempting automatic registration retry', {
            txId: this.txId,
            chain,
            errorMessage: chainStatus.errorMessage,
          })
          
          // Check if this is a forwarding registration issue
          const nobleMetadata = currentState?.chainStatus.noble?.metadata
          const forwardingAddress = nobleMetadata?.forwardingAddress as string | undefined
          const namadaReceiver = nobleMetadata?.namadaReceiver as string | undefined
          
          if (forwardingAddress && namadaReceiver) {
            try {
              // Noble chain support has been removed - use local stub
              logger.info('[FlowOrchestrator] Automatically retrying Noble forwarding registration', {
                txId: this.txId,
                forwardingAddress: forwardingAddress.slice(0, 16) + '...',
                recipientAddress: namadaReceiver.slice(0, 16) + '...',
              })
              
              const registrationResult = await executeRegistrationJob({
                txId: this.txId,
                forwardingAddress,
                recipientAddress: namadaReceiver,
                channelId: nobleMetadata?.channelId as string | undefined,
                fallback: nobleMetadata?.fallback as string | undefined,
                abortSignal: this.abortController.signal,
              })
              
              if (registrationResult.success) {
                logger.info('[FlowOrchestrator] Automatic registration retry succeeded, continuing flow', {
                  txId: this.txId,
                  alreadyRegistered: registrationResult.alreadyRegistered,
                  txHash: registrationResult.registrationTx.txHash,
                })
                
                // Update chain status to success and continue flow
                updateChainStatus(this.txId, 'noble', {
                  status: 'success',
                  errorMessage: undefined,
                  errorOccurredAt: undefined,
                })
                
                // Update the forwarding registration stage
                const existingStages = currentState?.chainStatus.noble?.stages || []
                const regStageIndex = existingStages.findIndex(
                  (s) => s.stage === DEPOSIT_STAGES.NOBLE_FORWARDING_REGISTRATION,
                )
                
                if (regStageIndex >= 0) {
                  const updatedStages = [...existingStages]
                  updatedStages[regStageIndex] = {
                    ...updatedStages[regStageIndex],
                    status: 'confirmed',
                    txHash: registrationResult.registrationTx.txHash,
                  }
                  
                  updateChainStatus(this.txId, 'noble', {
                    stages: updatedStages,
                    completedStages: [
                      ...(currentState?.chainStatus.noble?.completedStages || []),
                      DEPOSIT_STAGES.NOBLE_FORWARDING_REGISTRATION,
                    ],
                  })
                }
                
                // Continue flow execution (don't break)
                continue
              } else {
                logger.warn('[FlowOrchestrator] Automatic registration retry failed, stopping flow', {
                  txId: this.txId,
                  error: registrationResult.metadata.errorMessage,
                })
                // Stop flow execution - user must take action before proceeding
                break
              }
            } catch (error) {
              logger.error('[FlowOrchestrator] Automatic registration retry threw error, stopping flow', {
                txId: this.txId,
                error: error instanceof Error ? error.message : String(error),
              })
              // Stop flow execution - user must take action before proceeding
              break
            }
          } else {
            logger.warn('[FlowOrchestrator] Cannot auto-retry registration - missing metadata', {
              txId: this.txId,
              hasForwardingAddress: !!forwardingAddress,
              hasNamadaReceiver: !!namadaReceiver,
            })
            // Stop flow execution - user must take action before proceeding
            break
          }
        } else if (chainStatus.status === 'user_action_required') {
          // Other user_action_required cases or non-Noble chains - stop flow
          logger.info('[FlowOrchestrator] Chain requires user action - stopping flow', {
            txId: this.txId,
            chain,
            chainStatus: chainStatus.status,
            errorMessage: chainStatus.errorMessage,
          })
          // Stop flow execution - user must take action before proceeding
          break
        } else {
          // polling_timeout or polling_error - check if next chain requires prerequisites
        // Check if next chain requires prerequisites from this chain
        const nextChainIndex = i + 1
        if (nextChainIndex < chainOrder.length) {
          const nextChain = chainOrder[nextChainIndex]
          const requiresPrerequisites = await this.nextChainRequiresPrerequisites(chain, nextChain)
          
          if (requiresPrerequisites) {
            logger.error('[FlowOrchestrator] Chain failed and next chain requires prerequisites - stopping flow', {
              txId: this.txId,
              failedChain: chain,
              nextChain,
              chainStatus: chainStatus.status,
              reason: 'Cannot proceed to next chain without required prerequisites',
            })
            
            // Stop flow execution - cannot proceed without prerequisites
            // The flow status will be updated by checkFlowCompletion()
            break
          } else {
            // Next chain doesn't require prerequisites, log and continue
            logger.warn('[FlowOrchestrator] Chain failed, but next chain does not require prerequisites - continuing', {
              txId: this.txId,
              failedChain: chain,
              nextChain,
              chainStatus: chainStatus.status,
            })
          }
        } else {
          // This was the last chain, no next chain to check
          logger.debug('[FlowOrchestrator] Chain failed, but it was the last chain in the flow', {
            txId: this.txId,
            failedChain: chain,
            chainStatus: chainStatus.status,
          })
          }
        }
      }
    }

    // Clear global timeout timer if flow completed successfully
    if (this.globalTimeoutTimer) {
      clearTimeout(this.globalTimeoutTimer)
      this.globalTimeoutTimer = null
    }

    // Check if flow completed successfully
    await this.checkFlowCompletion()
  }

  /**
   * Check if the next chain requires prerequisites from the current chain
   * 
   * @param currentChain - Chain that just timed out or errored
   * @param nextChain - Next chain in the flow
   * @returns True if next chain requires prerequisites from current chain
   */
  private async nextChainRequiresPrerequisites(currentChain: ChainKey, nextChain: ChainKey): Promise<boolean> {
    // Deposit flow: EVM → Noble → Namada
    if (this.flowType === 'deposit') {
      // Noble requires cctpNonce from EVM
      if (currentChain === 'evm' && nextChain === 'noble') {
        return true
      }
      // Namada requires packetSequence from Noble
      if (currentChain === 'noble' && nextChain === 'namada') {
        return true
      }
    }
    
    // Payment flow: Namada → Noble → EVM
    if (this.flowType === 'payment') {
      // Noble requires packetSequence from Namada
      if (currentChain === 'namada' && nextChain === 'noble') {
        return true
      }
      // EVM requires cctpNonce from Noble
      if (currentChain === 'noble' && nextChain === 'evm') {
        return true
      }
    }
    
    return false
  }

  /**
   * Validate prerequisites before starting a chain polling job
   * 
   * @param chain - Chain key to validate prerequisites for
   * @returns True if prerequisites are met, false otherwise
   */
  private async validateChainPrerequisites(chain: ChainKey): Promise<boolean> {
    const state = getPollingState(this.txId)
    if (!state) {
      return false
    }

    // Namada deposit flow prerequisites
    if (chain === 'namada' && this.flowType === 'deposit') {
      const tx = transactionStorageService.getTransaction(this.txId)
      
      // Required: namadaReceiver (from metadata or transaction)
      const namadaReceiver = state.metadata?.namadaReceiver ||
                             tx?.depositDetails?.destinationAddress
      
      if (!namadaReceiver) {
        logger.warn('[FlowOrchestrator] Cannot start Namada polling: namadaReceiver missing', {
          txId: this.txId,
        })
        updateChainStatus(this.txId, chain, {
          status: 'polling_error',
          errorType: 'polling_error',
          errorMessage: 'Missing required parameter: namadaReceiver',
          errorOccurredAt: Date.now(),
        })
        return false
      }

      // Required: packetSequence from Noble (must be provided)
      const nobleStatus = state.chainStatus.noble
      const hasPacketSequence = state.metadata?.packetSequence !== undefined
      
      // Enhanced logging to debug metadata issues
      logger.debug('[FlowOrchestrator] Checking Namada prerequisites', {
        txId: this.txId,
        nobleStatus: nobleStatus?.status,
        hasPacketSequence,
        packetSequence: state.metadata?.packetSequence,
        metadataKeys: state.metadata ? Object.keys(state.metadata) : [],
      })
      
      if (!hasPacketSequence) {
        logger.warn('[FlowOrchestrator] Cannot start Namada polling: packetSequence missing (Noble must complete first)', {
          txId: this.txId,
          nobleStatus: nobleStatus?.status,
          hasNobleMetadata: !!state.metadata?.packetSequence,
          metadataKeys: state.metadata ? Object.keys(state.metadata) : [],
          packetSequenceValue: state.metadata?.packetSequence,
        })
        updateChainStatus(this.txId, chain, {
          status: 'polling_error',
          errorType: 'polling_error',
          errorMessage: 'Missing required parameter: packetSequence. Noble polling must complete first.',
          errorOccurredAt: Date.now(),
        })
        return false
      }
      
      // Required: startHeight (will be calculated if missing)
      const hasStartHeight = state.metadata?.startHeight !== undefined && (state.metadata.startHeight as number) > 0
      
      if (!hasStartHeight) {
        // Validate that we can calculate it
        if (!tx?.createdAt) {
          logger.warn('[FlowOrchestrator] Cannot start Namada polling: startHeight missing and createdAt not available', {
            txId: this.txId,
          })
          updateChainStatus(this.txId, chain, {
            status: 'polling_error',
            errorType: 'polling_error',
            errorMessage: 'Missing required parameter: startHeight (cannot calculate from createdAt)',
            errorOccurredAt: Date.now(),
          })
          return false
        }
        // startHeight will be calculated in buildPollParams
      }

      logger.debug('[FlowOrchestrator] Namada deposit prerequisites validated', {
        txId: this.txId,
        hasNamadaReceiver: !!namadaReceiver,
        hasPacketSequence: !!hasPacketSequence,
        hasStartHeight: hasStartHeight,
        canCalculateStartHeight: !!tx?.createdAt,
        nobleStatus: nobleStatus?.status,
      })
    }

    // Noble deposit flow prerequisites
    if (chain === 'noble' && this.flowType === 'deposit') {
      const evmStatus = state.chainStatus.evm
      const hasCctpNonce = state.metadata?.cctpNonce !== undefined

      if (!hasCctpNonce && evmStatus?.status !== 'success') {
        logger.warn('[FlowOrchestrator] Cannot start Noble polling: CCTP nonce missing and EVM not completed', {
          txId: this.txId,
          evmStatus: evmStatus?.status,
        })
        updateChainStatus(this.txId, chain, {
          status: 'polling_error',
          errorType: 'polling_error',
          errorMessage: 'Missing required parameter: cctpNonce (EVM polling must complete first)',
          errorOccurredAt: Date.now(),
        })
        return false
      }
    }

    return true
  }

  /**
   * Execute a single chain polling job
   */
  private async executeChainJob(chain: ChainKey, resume: boolean = false): Promise<void> {
    // Check if flow was cancelled before starting
    if (this.abortController.signal.aborted) {
      logger.debug('[FlowOrchestrator] Flow already cancelled, skipping chain job', {
        txId: this.txId,
        chain,
      })
      return
    }

    const poller = this.pollers.get(chain)
    if (!poller) {
      logger.error('[FlowOrchestrator] Poller not found for chain', {
        txId: this.txId,
        chain,
      })
      return
    }

    const state = getPollingState(this.txId)
    if (!state) {
      logger.error('[FlowOrchestrator] Polling state not found', {
        txId: this.txId,
      })
      return
    }

    // Check if chain already completed
    const chainStatus = state.chainStatus[chain]
    if (chainStatus?.status === 'success') {
      logger.info('[FlowOrchestrator] Chain already completed, skipping', {
        txId: this.txId,
        chain,
      })
      return
    }

    // Validate prerequisites before starting
    const prerequisitesMet = await this.validateChainPrerequisites(chain)
    if (!prerequisitesMet) {
      logger.warn('[FlowOrchestrator] Prerequisites not met, skipping chain polling job', {
        txId: this.txId,
        chain,
      })
      return
    }

    // Update current chain
    updatePollingState(this.txId, {
      currentChain: chain,
    })

    // Update chain status to pending
    updateChainStatus(this.txId, chain, {
      status: 'pending',
      completedStages: chainStatus?.completedStages || [],
    })

    // Get chain timeout and build poll parameters
    // Wrap in try-catch to handle errors during setup (e.g., chain key determination)
    let chainTimeout: number
    let pollParams: ChainPollParams
    try {
      // Get chain timeout (use chain as fallback if chainKey not available yet)
      chainTimeout = await getChainTimeout(
        state.metadata?.chainKey || chain,
        this.flowType,
      )

      // Build poll parameters (async to allow for startHeight calculation)
      // This may throw if chain key cannot be determined
      pollParams = await this.buildPollParams(chain, chainTimeout, resume)
    } catch (setupError) {
      // If setup fails (e.g., cannot determine chain key), update chain status to error
      const errorMessage = setupError instanceof Error ? setupError.message : String(setupError)
      const errorCode = (setupError as { code?: string | number }).code ||
        (setupError as { status?: number }).status ||
        (setupError as { response?: { status?: number } }).response?.status

      logger.error('[FlowOrchestrator] Failed to setup chain polling job', {
        txId: this.txId,
        chain,
        error: errorMessage,
        errorCode,
      })

      // Update chain status with error
      const currentRetryCount = state.chainStatus[chain]?.retryCount || 0
      updateChainStatus(this.txId, chain, {
        status: 'polling_error',
        errorType: 'polling_error',
        errorMessage: errorMessage,
        errorCode: errorCode?.toString(),
        errorOccurredAt: Date.now(),
        retryCount: currentRetryCount,
        lastRetryAt: Date.now(),
      })

      // Check flow completion to update overall flowStatus
      await this.checkFlowCompletion()
      return
    }

    logger.info('[FlowOrchestrator] Starting chain polling job', {
      txId: this.txId,
      chain,
      flowType: this.flowType,
      timeoutMs: chainTimeout,
    })

    // Set up chain-level timeout check
    const chainTimeoutTimer = setTimeout(async () => {
      // Check if chain is still pending after timeout
      const currentState = getPollingState(this.txId)
      const currentChainStatus = currentState?.chainStatus[chain]
      if (currentChainStatus?.status === 'pending') {
        logger.warn('[FlowOrchestrator] Chain-level timeout reached', {
          txId: this.txId,
          chain,
          timeoutMs: chainTimeout,
        })

        updateChainStatus(this.txId, chain, {
          status: 'polling_timeout',
          errorType: 'polling_timeout',
          errorMessage: `Chain polling timed out after ${chainTimeout}ms`,
          timeoutOccurredAt: Date.now(),
        })

        // Check flow completion to update overall flowStatus and transaction status
        await this.checkFlowCompletion()
      }
    }, chainTimeout)

    try {
      // Check abort signal before executing poller
      if (this.abortController.signal.aborted) {
        logger.debug('[FlowOrchestrator] Flow cancelled before poller execution', {
          txId: this.txId,
          chain,
        })
        updateChainStatus(this.txId, chain, {
          status: 'cancelled',
        })
        return
      }

      // Execute polling job
      const result = await poller.poll(pollParams)

      // Check abort signal after poller completes
      if (this.abortController.signal.aborted) {
        logger.debug('[FlowOrchestrator] Flow cancelled after poller execution', {
          txId: this.txId,
          chain,
        })
        return
      }

      // Clear chain timeout timer on success or error
      clearTimeout(chainTimeoutTimer)

      // Process result
      await this.processChainResult(chain, result)
    } catch (error) {
      // Clear chain timeout timer on exception
      clearTimeout(chainTimeoutTimer)
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = (error as { code?: string | number }).code ||
        (error as { status?: number }).status ||
        (error as { response?: { status?: number } }).response?.status

      logger.error('[FlowOrchestrator] Chain polling job error', {
        txId: this.txId,
        chain,
        error: errorMessage,
        errorCode,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      })

      // Get current retry count
      const currentRetryCount = state.chainStatus[chain]?.retryCount || 0

      // Update chain status with error
      updateChainStatus(this.txId, chain, {
        status: 'polling_error',
        errorType: 'polling_error',
        errorMessage: errorMessage,
        errorCode: errorCode?.toString(),
        errorOccurredAt: Date.now(),
        retryCount: currentRetryCount + 1,
        lastRetryAt: Date.now(),
      })

      // Check flow completion to update overall flowStatus
      await this.checkFlowCompletion()
    }
  }

  /**
   * Build poll parameters for a chain
   */
  private async buildPollParams(
    chain: ChainKey,
    timeoutMs: number,
    _resume: boolean,
  ): Promise<ChainPollParams> {
    // CRITICAL: Read fresh state to ensure we have the latest metadata
    // getPollingState handles migration automatically
    const state = getPollingState(this.txId)
    if (!state) {
      throw new Error('Polling state not found')
    }

    // Get existing chain params (for poller config only - timeout, interval, abortSignal)
    const existingChainParams = state.chainParams[chain]
    const chainKey = await this.getChainKey(chain)
    
    // Start with metadata from pollingState.metadata (single source of truth)
    // If metadata is missing, this is a critical error - log it
    let metadata: ChainPollMetadata = state.metadata ? { ...state.metadata } : {}
    
    if (!state.metadata || Object.keys(state.metadata).length === 0) {
      // This is a critical error - metadata should always be present
      // Log detailed state information for debugging
      logger.error('[FlowOrchestrator] CRITICAL: Metadata missing when building poll params', {
        txId: this.txId,
        chain,
        hasState: !!state,
        stateKeys: state ? Object.keys(state) : [],
        hasChainParams: !!state.chainParams,
        chainParamsKeys: state.chainParams ? Object.keys(state.chainParams) : [],
        // Check if metadata exists in chainParams (old structure that needs migration)
        hasEvmChainParams: !!state.chainParams?.evm,
        evmChainParamsKeys: state.chainParams?.evm ? Object.keys(state.chainParams.evm) : [],
        // Re-read state directly from transaction to see if it's a timing issue
        directTxState: (() => {
          const tx = transactionStorageService.getTransaction(this.txId)
          return {
            hasPollingState: !!tx?.pollingState,
            hasMetadata: !!tx?.pollingState?.metadata,
            metadataKeys: tx?.pollingState?.metadata ? Object.keys(tx.pollingState.metadata) : [],
          }
        })(),
      })
      
      // Try to restore from transaction as fallback
      const tx = transactionStorageService.getTransaction(this.txId)
      if (tx && this.flowType === 'deposit' && tx.depositDetails) {
        logger.warn('[FlowOrchestrator] Attempting to restore metadata from transaction', {
          txId: this.txId,
        })
        const details = tx.depositDetails
        const amountInBaseUnits = Math.round(parseFloat(details.amount) * 1_000_000).toString()
        const expectedAmountUusdc = `${amountInBaseUnits}uusdc`
        const restoredChainKey = tx.chain || details.chainName.toLowerCase().replace(/\s+/g, '-')
        
        metadata = {
          chainKey: restoredChainKey,
          txHash: tx.hash,
          recipient: tx.depositData?.nobleForwardingAddress || details.destinationAddress,
          amountBaseUnits: amountInBaseUnits,
          usdcAddress: tx.depositData?.usdcAddress,
          messageTransmitterAddress: tx.depositData?.messageTransmitterAddress,
          namadaReceiver: details.destinationAddress,
          expectedAmountUusdc,
          forwardingAddress: tx.depositData?.nobleForwardingAddress,
          fallback: tx.depositData?.fallback,
          flowType: this.flowType,
        }
        
        // Save restored metadata
        updatePollingState(this.txId, {
          metadata,
        })
      }
    }
    
    logger.info('[FlowOrchestrator] Building poll params - reading from single metadata source', {
      txId: this.txId,
      chain,
      hasMetadata: !!state.metadata,
      metadataKeys: state.metadata ? Object.keys(state.metadata) : [],
      actualMetadataKeys: Object.keys(metadata),
      hasInitialFields: {
        expectedAmountUusdc: 'expectedAmountUusdc' in metadata,
        namadaReceiver: 'namadaReceiver' in metadata,
        forwardingAddress: 'forwardingAddress' in metadata,
      },
    })
    
    // CRITICAL: For each chain, use the correct chain key for that specific chain
    // metadata.chainKey may contain the EVM chain key (for deposit flows), but Noble/Namada need their own keys
    // Override chainKey in metadata for the current chain being polled
    metadata.chainKey = chainKey  // Use the correct chain key for this specific chain
    metadata.flowType = this.flowType
    
    logger.info('[FlowOrchestrator] Set chainKey for poll params', {
      txId: this.txId,
      chain,
      chainKey,
      previousChainKey: state.metadata?.chainKey,
      metadataChainKeyAfterSet: metadata.chainKey,
    })
    
    // Create or update chainParams (for poller config only - no metadata)
    let chainParams = existingChainParams || {
      flowId: this.txId,
      chain,
      timeoutMs,
      intervalMs: 5000,
      abortSignal: this.abortController.signal,
    }
    
    // Save chainParams if it was created (for resumability)
    if (!existingChainParams) {
      updatePollingState(this.txId, {
        chainParams: {
          ...state.chainParams,
          [chain]: chainParams,
        },
      })
    }

    // chainKey and flowType are already set above - no need to override
    // The chainKey is set to the correct value for the current chain being polled
    
    // Fallback: For EVM deposit flows, get txHash from transaction if missing
    if (chain === 'evm' && this.flowType === 'deposit' && !metadata.txHash) {
      const tx = transactionStorageService.getTransaction(this.txId)
      if (tx?.hash) {
        logger.debug('[FlowOrchestrator] Using txHash from transaction as fallback', {
          txId: this.txId,
          txHash: tx.hash,
        })
        metadata.txHash = tx.hash
      }
    }

    // Fallback: For Namada payment flows, get namadaBlockHeight and namadaIbcTxHash from transaction if missing
    if (chain === 'namada' && this.flowType === 'payment') {
      const namadaParams = metadata as ChainPollMetadata
      const tx = transactionStorageService.getTransaction(this.txId)
      
      if (!namadaParams.namadaIbcTxHash && tx?.hash) {
        logger.debug('[FlowOrchestrator] Using namadaIbcTxHash from transaction as fallback', {
          txId: this.txId,
          txHash: tx.hash,
        })
        namadaParams.namadaIbcTxHash = tx.hash
        metadata.namadaIbcTxHash = tx.hash
      }
      
      if (!namadaParams.namadaBlockHeight && tx?.blockHeight) {
        const blockHeight = Number.parseInt(tx.blockHeight, 10)
        if (!isNaN(blockHeight)) {
          logger.debug('[FlowOrchestrator] Using namadaBlockHeight from transaction as fallback', {
            txId: this.txId,
            blockHeight,
          })
          namadaParams.namadaBlockHeight = blockHeight
          metadata.namadaBlockHeight = blockHeight
        }
      }
    }

    // For Namada deposit flows, ensure startHeight is calculated if missing
    if (chain === 'namada' && this.flowType === 'deposit') {
      const namadaParams = metadata as ChainPollMetadata
      if (!namadaParams.startHeight || namadaParams.startHeight === 0) {
        // Try to get timestamp from Noble IBC forward event (more accurate than tx creation time)
        let timestampMs: number | undefined
        
        // Read fresh state to get Noble chain stages
        const currentState = getPollingState(this.txId)
        const nobleStages = currentState?.chainStatus.noble?.stages || []
        const nobleIbcForwardedStage = nobleStages.find(
          (s) => s.stage === DEPOSIT_STAGES.NOBLE_IBC_FORWARDED,
        )
        
        if (nobleIbcForwardedStage?.metadata) {
          const blockMetadata = nobleIbcForwardedStage.metadata as {
            blockTimestamp?: number
          }
          if (blockMetadata?.blockTimestamp) {
            // blockTimestamp is in seconds (Unix timestamp), convert to milliseconds
            timestampMs = blockMetadata.blockTimestamp * 1000
            logger.info('[FlowOrchestrator] Using Noble IBC forward event timestamp for Namada start height', {
              txId: this.txId,
              blockTimestamp: blockMetadata.blockTimestamp,
              timestampMs,
            })
          }
        }
        
        // Fallback to transaction creation timestamp if Noble IBC forward event not available yet
        if (!timestampMs) {
          const tx = transactionStorageService.getTransaction(this.txId)
          if (tx?.createdAt) {
            timestampMs = tx.createdAt
            logger.info('[FlowOrchestrator] Noble IBC forward event not found, using transaction creation timestamp', {
              txId: this.txId,
              createdAt: tx.createdAt,
            })
          }
        }
        
        if (timestampMs) {
          try {
            const chainKey = await this.getChainKey('namada')
            const startHeight = await getStartHeightFromTimestamp(
              chainKey,
              'namada',
              timestampMs,
            )
            
            logger.info('[FlowOrchestrator] Calculated Namada start height from timestamp', {
              txId: this.txId,
              chainKey,
              timestampMs,
              source: nobleIbcForwardedStage ? 'noble_ibc_forwarded' : 'tx_createdAt',
              startHeight,
            })

            metadata = {
              ...metadata,
              startHeight,
            } as ChainPollMetadata

            // Store startHeight in metadata for future use
            updatePollingState(this.txId, {
              metadata: {
                ...metadata,
                startHeight,
              },
            })
            metadata.startHeight = startHeight
          } catch (error) {
            logger.warn('[FlowOrchestrator] Failed to calculate Namada start height, using fallback', {
              txId: this.txId,
              error: error instanceof Error ? error.message : String(error),
            })
            // Fallback: will use 0, which means poller will use latest block minus backscan
          }
        } else {
          logger.warn('[FlowOrchestrator] No timestamp available for start height calculation (neither Noble IBC forward event nor transaction createdAt)', {
            txId: this.txId,
            hasNobleStages: nobleStages.length > 0,
            hasNobleIbcForwardedStage: !!nobleIbcForwardedStage,
          })
        }
      }
    }

    // For Noble deposit flows, ensure cctpNonce is present (should already be in metadata from EVM)
    if (chain === 'noble' && this.flowType === 'deposit') {
      // cctpNonce should already be in metadata from EVM polling result
      if (!metadata.cctpNonce) {
        logger.warn('[FlowOrchestrator] cctpNonce missing from metadata for Noble deposit flow', {
          txId: this.txId,
          metadataKeys: Object.keys(metadata),
        })
      }
    }

    // For Namada deposit flows, ensure required metadata is present
    if (chain === 'namada' && this.flowType === 'deposit') {
      // namadaReceiver and packetSequence should already be in metadata from previous chains
      if (!metadata.namadaReceiver) {
        const tx = transactionStorageService.getTransaction(this.txId)
        const namadaReceiver = tx?.depositDetails?.destinationAddress
        if (namadaReceiver) {
          metadata.namadaReceiver = namadaReceiver
        }
      }
      if (!metadata.packetSequence) {
        logger.warn('[FlowOrchestrator] packetSequence missing from metadata for Namada deposit flow', {
          txId: this.txId,
          metadataKeys: Object.keys(metadata),
        })
      }
    }

    // For EVM payment flows, ensure required metadata is present
    if (chain === 'evm' && this.flowType === 'payment') {
      const evmParams = metadata as ChainPollMetadata
      const tx = transactionStorageService.getTransaction(this.txId)
      const chainKey = evmParams.chainKey as string | undefined
      
      // Load usdcAddress from chain config if missing
      if (!evmParams.usdcAddress && chainKey) {
        try {
          const { fetchEvmChainsConfig } = await import('@/services/config/chainConfigService')
          const { findChainByKey } = await import('@/config/chains')
          const evmConfig = await fetchEvmChainsConfig()
          const evmChain = findChainByKey(evmConfig, chainKey)
          
          if (evmChain?.contracts?.usdc) {
            logger.debug('[FlowOrchestrator] Loading usdcAddress from chain config', {
              txId: this.txId,
              chainKey,
              usdcAddress: evmChain.contracts.usdc,
            })
            evmParams.usdcAddress = evmChain.contracts.usdc
            metadata.usdcAddress = evmChain.contracts.usdc
          }
        } catch (error) {
          logger.warn('[FlowOrchestrator] Failed to load usdcAddress from chain config', {
            txId: this.txId,
            chainKey,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      
      // Load messageTransmitterAddress from chain config if missing
      if (!evmParams.messageTransmitterAddress && chainKey) {
        try {
          const { fetchEvmChainsConfig } = await import('@/services/config/chainConfigService')
          const { findChainByKey } = await import('@/config/chains')
          const evmConfig = await fetchEvmChainsConfig()
          const evmChain = findChainByKey(evmConfig, chainKey)
          
          if (evmChain?.contracts?.messageTransmitter) {
            logger.debug('[FlowOrchestrator] Loading messageTransmitterAddress from chain config', {
              txId: this.txId,
              chainKey,
              messageTransmitterAddress: evmChain.contracts.messageTransmitter,
            })
            evmParams.messageTransmitterAddress = evmChain.contracts.messageTransmitter
            metadata.messageTransmitterAddress = evmChain.contracts.messageTransmitter
          }
        } catch (error) {
          logger.warn('[FlowOrchestrator] Failed to load messageTransmitterAddress from chain config', {
            txId: this.txId,
            chainKey,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      
      // Load recipient from payment details if missing
      if (!evmParams.recipient) {
        const recipient = tx?.paymentDetails?.destinationAddress
        if (recipient) {
          logger.debug('[FlowOrchestrator] Loading recipient from payment details', {
            txId: this.txId,
            recipient,
          })
          evmParams.recipient = recipient
          metadata.recipient = recipient
        }
      }
      
      // Load amountBaseUnits from payment details if missing
      if (!evmParams.amountBaseUnits && tx?.paymentDetails?.amount) {
        const amountInBaseUnits = Math.round(parseFloat(tx.paymentDetails.amount) * 1_000_000).toString()
        logger.debug('[FlowOrchestrator] Loading amountBaseUnits from payment details', {
          txId: this.txId,
          amountBaseUnits: amountInBaseUnits,
        })
        evmParams.amountBaseUnits = amountInBaseUnits
        metadata.amountBaseUnits = amountInBaseUnits
      }
      
      // Calculate startBlock for EVM payment flows if missing
      // Use timestamp-based calculation for resumable polling
      // CRITICAL: For payment flows, use evmChainKey (destination chain), not chainKey which may be noble-testnet
      const evmChainKeyForStartHeight = this.flowType === 'payment' && metadata.evmChainKey
        ? metadata.evmChainKey as string
        : chainKey
      
      if (!evmParams.startBlock && evmChainKeyForStartHeight && tx?.createdAt) {
        try {
          const { getStartHeightFromTimestamp } = await import('./blockHeightLookup')
          // createdAt is already in milliseconds (number)
          const creationTimestampMs = tx.createdAt
          const startBlock = await getStartHeightFromTimestamp(evmChainKeyForStartHeight, 'evm', creationTimestampMs)
          
          logger.debug('[FlowOrchestrator] Calculated EVM startBlock from timestamp', {
            txId: this.txId,
            chainKey: evmChainKeyForStartHeight,
            flowType: this.flowType,
            creationTimestampMs,
            createdAt: tx.createdAt,
            startBlock,
          })
          
          evmParams.startBlock = startBlock
          metadata.startBlock = startBlock
        } catch (error) {
          logger.warn('[FlowOrchestrator] Failed to calculate EVM startBlock from timestamp, will use default', {
            txId: this.txId,
            chainKey: evmChainKeyForStartHeight,
            flowType: this.flowType,
            createdAt: tx.createdAt,
            error: error instanceof Error ? error.message : String(error),
          })
          // If calculation fails, let the poller use its default (latestBlock - 1)
        }
      }
    }

    // Return ChainPollParams with metadata from pollingState.metadata
    // CRITICAL: Log the final metadata being returned to verify chainKey is correct
    logger.info('[FlowOrchestrator] Returning ChainPollParams', {
      txId: this.txId,
      chain,
      metadataChainKey: metadata.chainKey,
      chainKeyVariable: chainKey,
      metadataKeys: Object.keys(metadata),
    })
    
    return {
      ...chainParams,
      flowId: this.txId,
      chain,
      flowType: this.flowType,
      timeoutMs,
      intervalMs: chainParams.intervalMs || 5000,
      abortSignal: this.abortController.signal,
      metadata,
    }
  }

  /**
   * Get actual chain key (e.g., 'sepolia', 'noble-testnet')
   *
   * @throws Error if chain key cannot be determined (for EVM chains)
   */
  private async getChainKey(chain: ChainKey): Promise<string> {
    const state = getPollingState(this.txId)

    // For Tendermint chains (Noble, Namada), use hardcoded fallback keys
    // Noble and Namada chain support has been removed, but keep fallbacks for compatibility
    if (chain === 'noble') {
      logger.debug('[FlowOrchestrator] Using hardcoded Noble chain key fallback', {
        txId: this.txId,
        chainKey: 'noble-testnet',
      })
      return 'noble-testnet'
    }
    if (chain === 'namada') {
      logger.debug('[FlowOrchestrator] Using hardcoded Namada chain key fallback', {
        txId: this.txId,
        chainKey: 'namada-testnet',
      })
      return 'namada-testnet'
    }

    // For EVM chains, check metadata for chain key
    if (chain === 'evm') {
      // For payment flows, use evmChainKey (destination chain)
      if (this.flowType === 'payment' && state?.metadata?.evmChainKey) {
        const chainKey = state.metadata.evmChainKey as string
        logger.debug('[FlowOrchestrator] Using EVM chain key from metadata.evmChainKey (payment flow)', {
          txId: this.txId,
          chain,
          chainKey,
        })
        return chainKey
      }
      
      // For deposit flows, use chainKey (source chain)
      if (this.flowType === 'deposit' && state?.metadata?.chainKey) {
        const chainKey = state.metadata.chainKey as string
        logger.debug('[FlowOrchestrator] Using chain key from pollingState.metadata (deposit flow)', {
          txId: this.txId,
          chain,
          chainKey,
        })
        return chainKey
      }
    }
    
    // Try to get from transaction's stored metadata
    const tx = transactionStorageService.getTransaction(this.txId)
    if (tx) {
      // For deposit flows, check transaction.chain first (might already be chain key)
      if (this.flowType === 'deposit' && chain === 'evm') {
        // Check if transaction.chain is the actual chain key (not just 'evm')
        if (tx.chain && tx.chain !== 'evm' && tx.chain !== 'noble' && tx.chain !== 'namada') {
          logger.debug('[FlowOrchestrator] Using chain key from transaction.chain', {
            txId: this.txId,
            chain: tx.chain,
          })
          return tx.chain
        }
        // Fallback to depositDetails.chainName
        if (tx.depositDetails?.chainName) {
          // Convert chain name to chain key (e.g., "Avalanche Fuji" -> "avalanche-fuji")
          const chainKey = tx.depositDetails.chainName.toLowerCase().replace(/\s+/g, '-')
          logger.debug('[FlowOrchestrator] Using chain key from depositDetails.chainName', {
            txId: this.txId,
            chainName: tx.depositDetails.chainName,
            chainKey,
          })
          return chainKey
        }
      }
      
      // For payment flows, check paymentDetails for chain information
      // Note: Noble and Namada already handled above with early returns,
      // so at this point chain must be 'evm'
      if (this.flowType === 'payment') {
        // For EVM in payment flows, check metadata for evmChainKey
        if (state?.metadata?.evmChainKey) {
          const chainKey = state.metadata.evmChainKey as string
          logger.debug('[FlowOrchestrator] Using EVM chain key from metadata', {
            txId: this.txId,
            chain,
            chainKey,
          })
          return chainKey
        }

        // Fallback to paymentDetails.chainName
        if (tx.paymentDetails?.chainName) {
          // Convert chain name to chain key (e.g., "Avalanche Fuji" -> "avalanche-fuji")
          const chainKey = tx.paymentDetails.chainName.toLowerCase().replace(/\s+/g, '-')
          logger.debug('[FlowOrchestrator] Using chain key from paymentDetails.chainName', {
            txId: this.txId,
            chainName: tx.paymentDetails.chainName,
            chainKey,
          })
          return chainKey
        }
      }
    }
    
    // No fallback for EVM chains - throw error if chain key cannot be determined
    throw new Error(
      `Cannot determine chain key for ${chain} chain in ${this.flowType} flow. ` +
      `Transaction ID: ${this.txId}. ` +
      `Please ensure chainKey is set in initialMetadata when starting polling.`
    )
  }


  /**
   * Process chain polling result
   */
  private async processChainResult(chain: ChainKey, result: ChainPollResult): Promise<void> {
    const state = getPollingState(this.txId)
    if (!state) {
      return
    }

    if (result.success && result.found) {
      // Success - update chain status
      const completedStages = result.stages
        .filter((s) => s.status === 'confirmed')
        .map((s) => s.stage)

      // Merge new stages with existing stages (intelligently - overwrite duplicates)
      const existingStages = state.chainStatus[chain]?.stages || []
      const newStages = result.stages || []
      const mergedStages = mergeStagesIntelligently(existingStages, newStages)

      updateChainStatus(this.txId, chain, {
        status: 'success',
        completedStages: [
          ...(state.chainStatus[chain]?.completedStages || []),
          ...completedStages,
        ],
        stages: mergedStages,
        completedAt: Date.now(),
        metadata: result.metadata,
      })

      // Update latest completed stage
      if (completedStages.length > 0) {
        const latestStage = completedStages[completedStages.length - 1]
        updatePollingState(this.txId, {
          latestCompletedStage: latestStage,
        })
      }

      // Update metadata in pollingState.metadata (single source of truth)
      // Merge result metadata with existing metadata to preserve initial fields
      if (result.metadata) {
        // CRITICAL: Read fresh state AFTER updateChainStatus to ensure we have the latest metadata
        // This ensures we're merging with the most up-to-date state
        const latestState = getPollingState(this.txId)
        const existingMetadata = latestState?.metadata || {}
        
        // Merge: existing metadata (preserves initial fields) + result metadata (adds new fields)
        // CRITICAL: Filter out undefined values from result.metadata to avoid overwriting with undefined
        const filteredResultMetadata: ChainPollMetadata = {}
        for (const key in result.metadata) {
          const value = result.metadata[key]
          // Only include non-undefined values (null is allowed, but undefined should be filtered)
          if (value !== undefined) {
            filteredResultMetadata[key] = value
          }
        }
        
        const mergedMetadata: ChainPollMetadata = {
          ...existingMetadata,
          ...filteredResultMetadata,
        }
        
        logger.info('[FlowOrchestrator] Updating metadata with chain result', {
          txId: this.txId,
          chain,
          existingMetadataKeys: Object.keys(existingMetadata),
          resultMetadataKeys: Object.keys(result.metadata),
          mergedMetadataKeys: Object.keys(mergedMetadata),
          preservedInitialFields: {
            expectedAmountUusdc: 'expectedAmountUusdc' in mergedMetadata,
            namadaReceiver: 'namadaReceiver' in mergedMetadata,
            forwardingAddress: 'forwardingAddress' in mergedMetadata,
          },
          packetSequenceInResult: 'packetSequence' in result.metadata,
          packetSequenceInExisting: 'packetSequence' in existingMetadata,
          packetSequenceInMerged: 'packetSequence' in mergedMetadata,
          packetSequenceValue: mergedMetadata.packetSequence,
          packetSequenceType: typeof mergedMetadata.packetSequence,
          resultPacketSequence: result.metadata.packetSequence,
        })
        
        // Update pollingState.metadata (single source of truth)
        updatePollingState(this.txId, {
          metadata: mergedMetadata,
        })
        
        // CRITICAL: Verify the update was persisted by reading state again
        // This ensures subsequent reads (like in validatePrerequisites) will see the updated metadata
        const verifyState = getPollingState(this.txId)
        logger.debug('[FlowOrchestrator] Verified metadata update', {
          txId: this.txId,
          chain,
          hasPacketSequence: verifyState?.metadata?.packetSequence !== undefined,
          packetSequence: verifyState?.metadata?.packetSequence,
          metadataKeys: verifyState?.metadata ? Object.keys(verifyState.metadata) : [],
        })
      }
    } else if (result.error) {
      // Error or user_action_required - preserve stages and metadata
      const existingStages = state.chainStatus[chain]?.stages || []
      const resultStages = result.stages || []
      // Merge intelligently - overwrite duplicates instead of appending
      const mergedStages = resultStages.length > 0 
        ? mergeStagesIntelligently(existingStages, resultStages)
        : existingStages

      // Extract confirmed stages to add to completedStages
      const confirmedStages = mergedStages
        .filter((s) => s.status === 'confirmed')
        .map((s) => s.stage)

      // Merge with existing completedStages (avoid duplicates)
      const existingCompletedStages = state.chainStatus[chain]?.completedStages || []
      const newCompletedStages = [
        ...existingCompletedStages,
        ...confirmedStages.filter((s) => !existingCompletedStages.includes(s)),
      ]

      const currentRetryCount = state.chainStatus[chain]?.retryCount || 0
      
      updateChainStatus(this.txId, chain, {
        status: result.error.type as ChainStatusValue,
        errorType: result.error.type,
        errorMessage: result.error.message,
        errorCode: result.error.code?.toString(),
        errorCategory: result.error.category,
        isRecoverable: result.error.isRecoverable,
        recoveryAction: result.error.recoveryAction,
        errorOccurredAt: result.error.occurredAt,
        retryCount: currentRetryCount + 1,
        lastRetryAt: Date.now(),
        completedStages: newCompletedStages.length > 0 ? newCompletedStages : undefined, // Preserve completed stages
        stages: mergedStages.length > 0 ? mergedStages : undefined, // Preserve stages
        ...(result.error.type === 'polling_timeout' && {
          timeoutOccurredAt: result.error.occurredAt,
        }),
        // Preserve metadata if available (e.g., packetSequence for user_action_required)
        ...(result.metadata && Object.keys(result.metadata).length > 0 && {
          metadata: {
            ...(state.chainStatus[chain]?.metadata || {}),
            ...result.metadata,
          },
        }),
      })

      // Preserve metadata even on error (for resumability)
      if (result.metadata && Object.keys(result.metadata).length > 0) {
        const existingMetadata = state.metadata || {}
        updatePollingState(this.txId, {
          metadata: {
            ...existingMetadata,
            ...result.metadata,
          },
        })
      }

      // Update flow status based on error type
      if (result.error.type === 'tx_error') {
        updatePollingState(this.txId, {
          flowStatus: 'tx_error',
          error: {
            type: result.error.type,
            message: result.error.message,
            occurredAt: result.error.occurredAt,
            chain,
          },
        })
      } else if (result.error.type === 'user_action_required') {
        updatePollingState(this.txId, {
          flowStatus: 'user_action_required',
          error: {
            type: result.error.type,
            message: result.error.message,
            occurredAt: result.error.occurredAt,
            chain,
          },
        })
      }

      // Check flow completion to update overall flowStatus
      // This ensures flowStatus is updated even for polling_error/polling_timeout
      await this.checkFlowCompletion()
    }
  }

  /**
   * Set up global timeout for entire flow
   */
  private async setupGlobalTimeout(chainOrder: readonly ChainKey[]): Promise<void> {
    const globalTimeout = await calculateGlobalTimeout([...chainOrder], this.flowType)
    const timeoutAt = Date.now() + globalTimeout

    updatePollingState(this.txId, {
      globalTimeoutAt: timeoutAt,
    })

    // Clear any existing timeout timer
    if (this.globalTimeoutTimer) {
      clearTimeout(this.globalTimeoutTimer)
    }

    // Set timeout to abort flow
    this.globalTimeoutTimer = setTimeout(() => {
      if (!this.abortController.signal.aborted) {
        logger.warn('[FlowOrchestrator] Global timeout reached', {
          txId: this.txId,
          timeoutMs: globalTimeout,
          timeoutAt,
        })

        this.abortController.abort()

        // Mark all pending chains as timed out
        const state = getPollingState(this.txId)
        if (state) {
          for (const chain of chainOrder) {
            const chainStatus = state.chainStatus[chain]
            if (chainStatus && chainStatus.status === 'pending') {
              updateChainStatus(this.txId, chain, {
                status: 'polling_timeout',
                errorType: 'polling_timeout',
                errorMessage: 'Global timeout reached before chain polling completed',
                timeoutOccurredAt: Date.now(),
              })
            }
          }
        }

        updatePollingState(this.txId, {
          flowStatus: 'polling_timeout',
          error: {
            type: 'polling_timeout',
            message: `Global timeout reached after ${globalTimeout}ms`,
            occurredAt: Date.now(),
          },
        })

        this.globalTimeoutTimer = null
      }
    }, globalTimeout)
  }

  /**
   * Check if flow completed (successfully or with errors)
   * Updates overall flowStatus based on chain statuses
   */
  private async checkFlowCompletion(): Promise<void> {
    const state = getPollingState(this.txId)
    if (!state) {
      return
    }

    const chainOrder = getChainOrder(this.flowType)
    
    // Check if all chains completed successfully
    const allChainsComplete = chainOrder.every(
      (chain) => state.chainStatus[chain]?.status === 'success',
    )

    if (allChainsComplete) {
      logger.info('[FlowOrchestrator] Flow completed successfully', {
        txId: this.txId,
        flowType: this.flowType,
      })

      updatePollingState(this.txId, {
        flowStatus: 'success',
        currentChain: undefined,
      })
      
      // Update top-level transaction status to reflect successful completion
      transactionStorageService.updateTransaction(this.txId, {
        status: 'finalized',
      })
      
      return
    }

    // Check if all chains have errored, timed out, or require user action (flow cannot continue)
    const allChainsErrored = chainOrder.every((chain) => {
      const chainStatus = state.chainStatus[chain]
      if (!chainStatus) {
        return false // Chain not started yet
      }
      return (
        chainStatus.status === 'tx_error' ||
        chainStatus.status === 'polling_error' ||
        chainStatus.status === 'polling_timeout' ||
        chainStatus.status === 'user_action_required'
      )
    })

    if (allChainsErrored) {
      // Determine the most severe error type
      // Priority: user_action_required > tx_error > polling_error > polling_timeout
      let overallErrorType: 'user_action_required' | 'tx_error' | 'polling_error' | 'polling_timeout' = 'polling_error'
      let overallErrorMessage = 'All chains encountered errors'
      let overallErrorOccurredAt = Date.now()

      for (const chain of chainOrder) {
        const chainStatus = state.chainStatus[chain]
        if (chainStatus?.status === 'user_action_required') {
          overallErrorType = 'user_action_required'
          overallErrorMessage = chainStatus.errorMessage || 'User action required on all chains'
          overallErrorOccurredAt = chainStatus.errorOccurredAt || Date.now()
          break // Highest priority, stop checking
        } else if (chainStatus?.status === 'tx_error') {
          overallErrorType = 'tx_error'
          overallErrorMessage = chainStatus.errorMessage || 'Transaction error on all chains'
          overallErrorOccurredAt = chainStatus.errorOccurredAt || Date.now()
        } else if (
          chainStatus?.status === 'polling_error' &&
          overallErrorType !== 'tx_error'
        ) {
          overallErrorType = 'polling_error'
          overallErrorMessage = chainStatus.errorMessage || 'Polling error on all chains'
          overallErrorOccurredAt = chainStatus.errorOccurredAt || Date.now()
        } else if (
          chainStatus?.status === 'polling_timeout' &&
          overallErrorType !== 'tx_error' &&
          overallErrorType !== 'polling_error'
        ) {
          overallErrorType = 'polling_timeout'
          overallErrorMessage = chainStatus.errorMessage || 'Polling timeout on all chains'
          overallErrorOccurredAt = chainStatus.timeoutOccurredAt || Date.now()
        }
      }

      logger.warn('[FlowOrchestrator] Flow failed - all chains errored', {
        txId: this.txId,
        flowType: this.flowType,
        overallErrorType,
      })

      updatePollingState(this.txId, {
        flowStatus: overallErrorType,
        currentChain: undefined,
        error: {
          type: overallErrorType,
          message: overallErrorMessage,
          occurredAt: overallErrorOccurredAt,
        },
      })
      
      // Map polling error types to top-level status
      let topLevelStatus: StoredTransaction['status']
      if (overallErrorType === 'user_action_required') {
        topLevelStatus = 'broadcasted' // Still in progress, waiting for user
      } else if (overallErrorType === 'tx_error') {
        topLevelStatus = 'error' // Transaction actually failed
      } else if (overallErrorType === 'polling_error' || overallErrorType === 'polling_timeout') {
        topLevelStatus = 'undetermined' // Couldn't verify status - tx may have succeeded
      } else {
        topLevelStatus = 'undetermined'
      }
      
      // Update top-level transaction status to reflect polling state
      transactionStorageService.updateTransaction(this.txId, {
        status: topLevelStatus,
      })
      
      return
    }

    // Check if current chain has errored and blocks the flow from continuing
    // This handles cases where the first chain (or a blocking chain) errors before other chains start
    const currentChain = state.currentChain
    let blockingChain: ChainKey | null = null
    let blockingChainStatus: ChainStatus | null = null
    
    if (currentChain) {
      const currentChainStatus = state.chainStatus[currentChain]
      if (
        currentChainStatus &&
        (currentChainStatus.status === 'tx_error' ||
          currentChainStatus.status === 'polling_error' ||
          currentChainStatus.status === 'polling_timeout' ||
          currentChainStatus.status === 'user_action_required')
      ) {
        blockingChain = currentChain
        blockingChainStatus = currentChainStatus
      }
    } else {
      // If currentChain is not set, check the first chain in the flow that has errored
      for (const chain of chainOrder) {
        const chainStatus = state.chainStatus[chain]
        if (
          chainStatus &&
          (chainStatus.status === 'tx_error' ||
            chainStatus.status === 'polling_error' ||
            chainStatus.status === 'polling_timeout' ||
            chainStatus.status === 'user_action_required')
        ) {
          blockingChain = chain
          blockingChainStatus = chainStatus
          break // Use first errored chain
        }
      }
    }
    
    if (blockingChain && blockingChainStatus) {
      // Check if this chain blocks the flow (next chain requires prerequisites)
      const blockingChainIndex = chainOrder.indexOf(blockingChain)
      if (blockingChainIndex >= 0 && blockingChainIndex < chainOrder.length - 1) {
        const nextChain = chainOrder[blockingChainIndex + 1]
        const requiresPrerequisites = await this.nextChainRequiresPrerequisites(blockingChain, nextChain)
        
        if (requiresPrerequisites) {
          // Blocking chain errored and blocks the flow - update flowStatus immediately
          logger.warn('[FlowOrchestrator] Blocking chain errored and blocks flow - updating flowStatus', {
            txId: this.txId,
            failedChain: blockingChain,
            nextChain,
            chainStatus: blockingChainStatus.status,
          })
          
          const errorType = blockingChainStatus.status as 'user_action_required' | 'tx_error' | 'polling_error' | 'polling_timeout'
          updatePollingState(this.txId, {
            flowStatus: errorType,
            currentChain: undefined,
            error: {
              type: errorType,
              message: blockingChainStatus.errorMessage || `Chain ${blockingChain} encountered an error`,
              occurredAt: blockingChainStatus.errorOccurredAt || blockingChainStatus.timeoutOccurredAt || Date.now(),
            },
          })
          
          // Map polling error types to top-level status
          let topLevelStatus: StoredTransaction['status']
          if (errorType === 'user_action_required') {
            topLevelStatus = 'broadcasted' // Still in progress, waiting for user
          } else if (errorType === 'tx_error') {
            topLevelStatus = 'error' // Transaction actually failed
          } else if (errorType === 'polling_error' || errorType === 'polling_timeout') {
            topLevelStatus = 'undetermined' // Couldn't verify status - tx may have succeeded
          } else {
            topLevelStatus = 'undetermined'
          }
          
          // Update top-level transaction status to reflect polling state
          transactionStorageService.updateTransaction(this.txId, {
            status: topLevelStatus,
          })
          
          return
        }
      }
    }

    // Check if flow is stuck (all chains have status but none are pending or success)
    // This handles cases where some chains errored but flow hasn't been marked as failed
    const allChainsHaveStatus = chainOrder.every((chain) => {
      const chainStatus = state.chainStatus[chain]
      return chainStatus !== undefined && chainStatus.status !== 'pending'
    })

    if (allChainsHaveStatus && !allChainsComplete) {
      // Some chains succeeded, some errored - determine overall status
      const hasUserActionRequired = chainOrder.some(
        (chain) => state.chainStatus[chain]?.status === 'user_action_required',
      )
      const hasTxError = chainOrder.some(
        (chain) => state.chainStatus[chain]?.status === 'tx_error',
      )
      const hasPollingError = chainOrder.some(
        (chain) => state.chainStatus[chain]?.status === 'polling_error',
      )
      const hasTimeout = chainOrder.some(
        (chain) => state.chainStatus[chain]?.status === 'polling_timeout',
      )

      // Priority: user_action_required > tx_error > polling_error > polling_timeout
      let topLevelStatus: StoredTransaction['status'] | undefined
      
      if (hasUserActionRequired) {
        updatePollingState(this.txId, {
          flowStatus: 'user_action_required',
        })
        // User action required - set status to user_action_required
        topLevelStatus = 'user_action_required'
      } else if (hasTxError) {
        updatePollingState(this.txId, {
          flowStatus: 'tx_error',
        })
        topLevelStatus = 'error' // Transaction actually failed
      } else if (hasPollingError) {
        updatePollingState(this.txId, {
          flowStatus: 'polling_error',
        })
        topLevelStatus = 'undetermined' // Couldn't verify status - tx may have succeeded
      } else if (hasTimeout) {
        updatePollingState(this.txId, {
          flowStatus: 'polling_timeout',
        })
        topLevelStatus = 'undetermined' // Couldn't verify status - tx may have succeeded
      }
      
      // Update top-level transaction status to reflect polling state
      if (topLevelStatus) {
        transactionStorageService.updateTransaction(this.txId, {
          status: topLevelStatus,
        })
      }
    }
  }
}

/**
 * Create flow orchestrator instance
 */
export function createFlowOrchestrator(
  options: FlowOrchestratorOptions,
): FlowOrchestrator {
  return new FlowOrchestrator(options)
}


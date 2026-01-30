/**
 * Namada Chain Poller
 * 
 * Polls Namada chain for IBC events (write_acknowledgement for deposits, send_packet for payments).
 * Implements ChainPoller interface for modularity.
 * 
 * Supports:
 * - Deposit flow: write_acknowledgement by packet_sequence (requires packetSequence from Noble)
 * - Payment flow: send_packet by inner-tx-hash at specific block height
 */

import type {
  ChainPoller,
  ChainPollParams,
  ChainPollResult,
  NamadaPollParams,
} from './types'
import type { ChainStage } from '@/types/flow'
import {
  retryWithBackoff,
  createPollTimeout,
  isAborted,
  createErrorResult,
  indexAttributes,
} from './basePoller'
import { createTendermintRpcClient } from './tendermintRpcClient'
import { DEPOSIT_STAGES, PAYMENT_STAGES } from '@/shared/flowStages'
import { logger } from '@/utils/logger'
import { extractTendermintBlockMetadata } from './blockMetadataExtractor'
import { updateChainStageIncremental } from './pollingStateManager'

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll for deposit flow: write_acknowledgement by packet_sequence
 * Requires packetSequence from Noble polling result.
 */
async function pollForDeposit(
  params: ChainPollParams,
  rpcClient: ReturnType<typeof createTendermintRpcClient>,
): Promise<ChainPollResult> {
  const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000
  const intervalMs = params.intervalMs ?? 5000
  const blockRequestDelayMs = (params as NamadaPollParams).blockRequestDelayMs ?? 100
  const { controller, cleanup, wasTimeout } = createPollTimeout(
    timeoutMs,
    params.flowId,
    params.abortSignal,
  )
  const abortSignal = params.abortSignal || controller.signal

  logger.info('[NamadaPoller] Starting Namada deposit poll', {
    flowId: params.flowId,
    startHeight: params.metadata.startHeight,
    packetSequence: params.metadata.packetSequence,
  })

  const stages: ChainStage[] = [
    {
      stage: DEPOSIT_STAGES.NAMADA_POLLING,
      status: 'pending',
      source: 'poller',
      occurredAt: new Date().toISOString(),
    },
  ]

  // Incrementally update: NAMADA_POLLING has started (pending)
  updateChainStageIncremental(params.flowId, 'namada', stages[0])

  const deadline = Date.now() + timeoutMs
  let nextHeight = params.metadata.startHeight || 0

  let ackFound = false
  let foundAt: number | undefined
  let namadaTxHash: string | undefined

  // Require packetSequence - fail early if not provided
  if (params.metadata.packetSequence === undefined || params.metadata.packetSequence === null) {
    logger.error('[NamadaPoller] packetSequence is required for Namada deposit polling', {
      flowId: params.flowId,
    })
    return createErrorResult(
      'polling_error',
      'Missing required parameter: packetSequence. Noble polling must complete first.',
    )
  }

  const requiredPacketSequence = params.metadata.packetSequence

  try {
    while (Date.now() < deadline && !ackFound) {
      if (isAborted(abortSignal)) break

      const latest = await retryWithBackoff(
        () => rpcClient.getLatestBlockHeight(abortSignal),
        3,
        500,
        5000,
        abortSignal,
      )

      logger.debug('[NamadaPoller] Deposit poll progress', {
        flowId: params.flowId,
        latest,
        nextHeight,
      })

      while (nextHeight <= latest && !ackFound) {
        if (isAborted(abortSignal)) break

        try {
          const blockResults = await retryWithBackoff(
            () => rpcClient.getBlockResults(nextHeight, abortSignal),
            3,
            500,
            5000,
            abortSignal,
          )

          if (!blockResults) {
            logger.debug('[NamadaPoller] No block results for height', {
              flowId: params.flowId,
              height: nextHeight,
            })
            nextHeight++
            await sleep(blockRequestDelayMs)
            continue
          }

          // Access end_block_events
          const endEvents = (blockResults as unknown as {
            end_block_events?: Array<{
              type: string
              attributes?: Array<{ key: string; value: string; index?: boolean }>
            }>
          }).end_block_events || []

          // Search for write_acknowledgement event matching packet_sequence
          for (const ev of endEvents) {
            if (ev?.type !== 'write_acknowledgement') continue

            const attrs = indexAttributes(ev.attributes)
            const packetSeqStr = attrs['packet_sequence']
            const packetAck = attrs['packet_ack']
            const innerTxHashAttr = attrs['inner-tx-hash']

            // Match by packet_sequence
            if (!packetSeqStr) continue
            const packetSeq = Number.parseInt(packetSeqStr, 10)
            if (packetSeq !== requiredPacketSequence) continue

            logger.debug('[NamadaPoller] Found write_acknowledgement with matching packet_sequence', {
              flowId: params.flowId,
              height: nextHeight,
              packetSequence: packetSeq,
              packetAck,
              hasInnerTxHash: !!innerTxHashAttr,
            })

            // Verify packet_ack is success code
            if (packetAck !== '{"result":"AQ=="}') {
              logger.error('[NamadaPoller] Packet acknowledgement indicates failure', {
                flowId: params.flowId,
                height: nextHeight,
                packetSequence: packetSeq,
                packetAck,
              })
              cleanup()
              // Include metadata and stages that were discovered before error (write_acknowledgement was found)
              return {
                ...createErrorResult(
                  'tx_error',
                  `Packet acknowledgement indicates failure: ${packetAck}`,
                ),
                metadata: {
                  ...params.metadata,
                  namadaTxHash,
                  foundAt: nextHeight,
                },
                stages,
              }
            }

            // Extract inner-tx-hash from write_acknowledgement event
            if (innerTxHashAttr) {
              namadaTxHash = innerTxHashAttr
            } else {
              logger.warn('[NamadaPoller] inner-tx-hash not found in write_acknowledgement event', {
                flowId: params.flowId,
                height: nextHeight,
                packetSequence: packetSeq,
              })
            }

            ackFound = true
            foundAt = nextHeight
            logger.info('[NamadaPoller] Namada write_acknowledgement matched by packet_sequence', {
              flowId: params.flowId,
              height: nextHeight,
              packetSequence: packetSeq,
              txHash: namadaTxHash,
            })

            // Extract block metadata (height, timestamp, tx hash)
            let blockMetadata: { blockHeight?: number | string; blockTimestamp?: number; eventTxHash?: string } = {}
            try {
              blockMetadata = await extractTendermintBlockMetadata(
                rpcClient,
                nextHeight,
                namadaTxHash || '',
                params.abortSignal,
              )
            } catch (error) {
              // Log warning but continue - block metadata extraction failure shouldn't break polling
              logger.warn('[NamadaPoller] Failed to extract block metadata for deposit', {
                flowId: params.flowId,
                blockHeight: nextHeight,
                txHash: namadaTxHash,
                error: error instanceof Error ? error.message : String(error),
              })
            }

            // Update NAMADA_POLLING stage to confirmed
            stages[0] = {
              stage: DEPOSIT_STAGES.NAMADA_POLLING,
              status: 'confirmed',
              source: 'poller',
              occurredAt: new Date().toISOString(),
            }

            // Incrementally update: NAMADA_POLLING is now confirmed
            updateChainStageIncremental(params.flowId, 'namada', stages[0])

            const namadaReceivedStage: ChainStage = {
              stage: DEPOSIT_STAGES.NAMADA_RECEIVED,
              status: 'confirmed',
              source: 'poller',
              txHash: namadaTxHash,
              occurredAt: new Date().toISOString(),
              // Add block metadata to stage metadata
              metadata: Object.keys(blockMetadata).length > 0 ? blockMetadata : undefined,
            }
            stages.push(namadaReceivedStage)

            // Incrementally update: NAMADA_RECEIVED is confirmed
            updateChainStageIncremental(params.flowId, 'namada', namadaReceivedStage)
            break
          }
        } catch (error) {
          logger.warn('[NamadaPoller] Fetch failed for height after retries, skipping block', {
            flowId: params.flowId,
            height: nextHeight,
            error: error instanceof Error ? error.message : String(error),
          })
          nextHeight++
          await sleep(blockRequestDelayMs)
          continue
        }

        nextHeight++
        await sleep(blockRequestDelayMs)
      }

      if (ackFound) break
      await sleep(intervalMs)
    }

    cleanup()

    if (wasTimeout()) {
      // Include any metadata and stages that were discovered before timeout
      return {
        ...createErrorResult('polling_timeout', 'Namada deposit polling timed out'),
        metadata: params.metadata,
        stages,
      }
    }

    if (!ackFound) {
      // Include any metadata and stages that were discovered before timeout
      return {
        ...createErrorResult('polling_timeout', 'Namada write_acknowledgement not found'),
        metadata: params.metadata,
        stages,
      }
    }

    logger.info('[NamadaPoller] Namada deposit poll completed', {
      flowId: params.flowId,
      ackFound,
      foundAt,
      namadaTxHash,
    })

    return {
      success: true,
      found: true,
      metadata: {
        ...params.metadata,
        namadaTxHash,
        foundAt,
      },
      stages,
      height: foundAt,
    }
  } catch (error) {
    cleanup()

    if (isAborted(abortSignal)) {
      // Include any metadata and stages that were discovered before abort
      return {
        ...createErrorResult('polling_error', 'Polling cancelled'),
        metadata: params.metadata,
        stages,
      }
    }

    logger.error('[NamadaPoller] Namada deposit poll error', {
      flowId: params.flowId,
      error: error instanceof Error ? error.message : String(error),
    })

    // Include any metadata and stages that were discovered before error
    return {
      ...createErrorResult(
        'polling_error',
        error instanceof Error ? error.message : 'Unknown error',
      ),
      metadata: params.metadata,
      stages,
    }
  }
}

/**
 * Poll for payment flow: send_packet by inner-tx-hash at specific block height
 */
async function pollForPaymentIbcSend(
  params: ChainPollParams,
  rpcClient: ReturnType<typeof createTendermintRpcClient>,
): Promise<ChainPollResult> {
  const namadaBlockHeightRaw = params.metadata.namadaBlockHeight
  const namadaIbcTxHash = params.metadata.namadaIbcTxHash as string | undefined

  // Early validation: ensure required prerequisites are present
  // Don't fall through to deposit flow if missing
  if (namadaBlockHeightRaw === undefined || namadaBlockHeightRaw === null) {
    logger.error('[NamadaPoller] namadaBlockHeight is required for payment flow', {
      flowId: params.flowId,
      namadaBlockHeight: namadaBlockHeightRaw,
    })
    return createErrorResult(
      'polling_error',
      'namadaBlockHeight is required for payment flow. The block height where the payment transaction was submitted must be provided.',
    )
  }

  // Convert to number if it's a string
  const namadaBlockHeight = typeof namadaBlockHeightRaw === 'number' 
    ? namadaBlockHeightRaw 
    : typeof namadaBlockHeightRaw === 'string' 
      ? Number.parseInt(namadaBlockHeightRaw, 10)
      : undefined

  if (namadaBlockHeight === undefined || isNaN(namadaBlockHeight)) {
    logger.error('[NamadaPoller] Invalid namadaBlockHeight for payment flow', {
      flowId: params.flowId,
      namadaBlockHeightRaw,
    })
    return createErrorResult(
      'polling_error',
      'Invalid namadaBlockHeight for payment flow. The block height must be a valid number.',
    )
  }

  if (!namadaIbcTxHash) {
    logger.error('[NamadaPoller] namadaIbcTxHash is required for payment flow', {
      flowId: params.flowId,
      namadaIbcTxHash,
    })
    return createErrorResult(
      'polling_error',
      'namadaIbcTxHash is required for payment flow. The inner transaction hash must be provided.',
    )
  }

  logger.info('[NamadaPoller] Starting Namada payment IBC send lookup', {
    flowId: params.flowId,
    blockHeight: namadaBlockHeight,
    txHash: namadaIbcTxHash,
  })

  const stages: ChainStage[] = [
    {
      stage: PAYMENT_STAGES.NAMADA_IBC_SENT,
      status: 'pending',
      source: 'poller',
      occurredAt: new Date().toISOString(),
    },
  ]

  // Incrementally update: NAMADA_IBC_SENT has started (pending)
  updateChainStageIncremental(params.flowId, 'namada', stages[0])

  try {
    // Fetch block_results at the provided height
    const blockResults = await retryWithBackoff(
      () => rpcClient.getBlockResults(namadaBlockHeight, params.abortSignal),
      3,
      500,
      5000,
      params.abortSignal,
    )

    if (!blockResults) {
      logger.error('[NamadaPoller] Block results not found at height', {
        flowId: params.flowId,
        blockHeight: namadaBlockHeight,
      })
      // Include metadata and stages that were discovered before error
      return {
        ...createErrorResult(
          'polling_error',
          `Block results not found at height ${namadaBlockHeight}`,
        ),
        metadata: params.metadata,
        stages,
      }
    }

    // Access end_block_events
    const endEvents = (blockResults as unknown as {
      end_block_events?: Array<{
        type: string
        attributes?: Array<{ key: string; value: string; index?: boolean }>
      }>
    }).end_block_events || []

    logger.debug('[NamadaPoller] Searching end_block_events for send_packet event', {
      flowId: params.flowId,
      blockHeight: namadaBlockHeight,
      eventCount: endEvents.length,
    })

    // Search for send_packet event matching inner-tx-hash
    const txHashLower = namadaIbcTxHash.toLowerCase()
    let packetSequence: number | undefined

    for (const event of endEvents) {
      if (event?.type !== 'send_packet') continue

      const attrs = indexAttributes(event.attributes || [])
      const innerTxHash = attrs['inner-tx-hash']

      if (!innerTxHash) continue

      // Case-insensitive comparison
      if (innerTxHash.toLowerCase() === txHashLower) {
        logger.debug('[NamadaPoller] Found send_packet event with matching inner-tx-hash', {
          flowId: params.flowId,
          blockHeight: namadaBlockHeight,
          innerTxHash,
          txHash: namadaIbcTxHash,
        })

        // Extract packet_sequence
        const packetSeqStr = attrs['packet_sequence']
        if (packetSeqStr) {
          packetSequence = Number.parseInt(packetSeqStr, 10)
          if (!packetSequence || packetSequence <= 0) {
            logger.error('[NamadaPoller] Invalid packet_sequence value', {
              flowId: params.flowId,
              blockHeight: namadaBlockHeight,
              packetSeqStr,
            })
            // Include metadata and stages that were discovered before error (send_packet event was found)
            return {
              ...createErrorResult('polling_error', `Invalid packet_sequence: ${packetSeqStr}`),
              metadata: params.metadata,
              stages,
            }
          }

          logger.info('[NamadaPoller] Namada payment IBC send event found and packet_sequence extracted', {
            flowId: params.flowId,
            blockHeight: namadaBlockHeight,
            txHash: namadaIbcTxHash,
            packetSequence,
          })

          // Extract block metadata (height, timestamp, tx hash)
          let blockMetadata: { blockHeight?: number | string; blockTimestamp?: number; eventTxHash?: string } = {}
          try {
            blockMetadata = await extractTendermintBlockMetadata(
              rpcClient,
              namadaBlockHeight,
              namadaIbcTxHash,
              params.abortSignal,
            )
          } catch (error) {
            // Log warning but continue - block metadata extraction failure shouldn't break polling
            logger.warn('[NamadaPoller] Failed to extract block metadata for payment', {
              flowId: params.flowId,
              blockHeight: namadaBlockHeight,
              txHash: namadaIbcTxHash,
              error: error instanceof Error ? error.message : String(error),
            })
          }

          const namadaIbcSentStage: ChainStage = {
            stage: PAYMENT_STAGES.NAMADA_IBC_SENT,
            status: 'confirmed',
            source: 'poller',
            txHash: namadaIbcTxHash,
            occurredAt: new Date().toISOString(),
            // Add block metadata to stage metadata
            metadata: Object.keys(blockMetadata).length > 0 ? blockMetadata : undefined,
          }
          stages.push(namadaIbcSentStage)

          // Incrementally update: NAMADA_IBC_SENT is confirmed
          updateChainStageIncremental(params.flowId, 'namada', namadaIbcSentStage)

          return {
            success: true,
            found: true,
            metadata: {
              ...params.metadata,
              packetSequence,
              namadaTxHash: namadaIbcTxHash,
            },
            stages,
            height: namadaBlockHeight,
          }
        } else {
          logger.error('[NamadaPoller] packet_sequence attribute not found in send_packet event', {
            flowId: params.flowId,
            blockHeight: namadaBlockHeight,
            txHash: namadaIbcTxHash,
          })
          // Include metadata and stages that were discovered before error (send_packet event was found)
          return {
            ...createErrorResult(
              'polling_error',
              'packet_sequence attribute not found in send_packet event',
            ),
            metadata: params.metadata,
            stages,
          }
        }
      }
    }

    logger.warn('[NamadaPoller] No send_packet event found with matching inner-tx-hash', {
      flowId: params.flowId,
      blockHeight: namadaBlockHeight,
      txHash: namadaIbcTxHash,
      eventCount: endEvents.length,
    })

    // Include metadata and stages that were discovered before error
    return {
      ...createErrorResult(
        'polling_error',
        `No send_packet event found with matching inner-tx-hash ${namadaIbcTxHash} at height ${namadaBlockHeight}`,
      ),
      metadata: params.metadata,
      stages,
    }
  } catch (error) {
    logger.error('[NamadaPoller] Namada payment IBC send lookup error', {
      flowId: params.flowId,
      blockHeight: namadaBlockHeight,
      error: error instanceof Error ? error.message : String(error),
    })

    // Include any metadata and stages that were discovered before error
    return {
      ...createErrorResult(
        'polling_error',
        error instanceof Error ? error.message : 'Unknown error',
      ),
      metadata: params.metadata,
      stages,
    }
  }
}

/**
 * Namada Chain Poller Implementation
 * Implements ChainPoller interface for modularity
 */
export class NamadaPoller implements ChainPoller {
  /**
   * Poll Namada chain for IBC events
   * 
   * @param params - Polling parameters
   * @returns Polling result with success status, metadata, and stages
   */
  async poll(params: ChainPollParams): Promise<ChainPollResult> {
    // Get Tendermint RPC client for Namada
    const chainKey = params.metadata.chainKey || 'namada-testnet'
    let rpcUrl: string
    try {
      // Namada/Tendermint chain support has been removed - use env fallback
      const { env } = await import('@/config/env')
      rpcUrl = env.namadaRpc()
    } catch (error) {
      logger.error('[NamadaPoller] Failed to get Tendermint RPC URL', {
        chainKey,
        error: error instanceof Error ? error.message : String(error),
      })
      return createErrorResult(
        'polling_error',
        `Failed to get RPC URL for Namada chain: ${chainKey}`,
      )
    }

    const rpcClient = createTendermintRpcClient(rpcUrl)

    // Determine flow type: Priority 1 - explicit flowType from metadata
    // Priority 2 - metadata-based detection (for backward compatibility)
    const flowType = params.metadata.flowType as 'deposit' | 'payment' | undefined
    const hasPaymentMetadata =
      params.metadata.namadaBlockHeight !== undefined &&
      Boolean(params.metadata.namadaIbcTxHash)
    
    const isPaymentFlow = flowType === 'payment' || 
      (flowType !== 'deposit' && hasPaymentMetadata)

    if (isPaymentFlow) {
      logger.info('[NamadaPoller] Using payment flow (IBC send lookup)', {
        flowId: params.flowId,
        flowType: flowType || 'detected from metadata',
        blockHeight: params.metadata.namadaBlockHeight,
        txHash: params.metadata.namadaIbcTxHash,
      })
      return pollForPaymentIbcSend(params, rpcClient)
    } else {
      logger.info('[NamadaPoller] Using deposit flow (write_acknowledgement polling)', {
        flowId: params.flowId,
        flowType: flowType || 'detected from metadata',
        startHeight: params.metadata.startHeight,
        packetSequence: params.metadata.packetSequence,
      })
      return pollForDeposit(params, rpcClient)
    }
  }
}

/**
 * Create Namada poller instance
 */
export function createNamadaPoller(): ChainPoller {
  return new NamadaPoller()
}


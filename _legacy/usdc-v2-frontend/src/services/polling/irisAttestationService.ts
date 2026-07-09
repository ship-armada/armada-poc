/**
 * Iris Attestation Service
 * Handles MessageSent event extraction and Iris API polling
 * Ported from usdc-v2-backend/src/modules/iris-attestation/service.ts
 */

import { ethers } from 'ethers'
import axios, { type AxiosInstance } from 'axios'
import { logger } from '@/utils/logger'
import { env } from '@/config/env'
import { parseMessage, parseBurnMessage } from './irisMessageParser'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { findChainByKey } from '@/config/chains'
/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// MessageSent event signature: keccak256("MessageSent(bytes)")
// This is the first topic in the event log
const MESSAGE_SENT_EVENT_TOPIC = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'

// DepositForBurn V2 event signature: keccak256("DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)")
// Note: V2 no longer includes nonce in DepositForBurn event. Nonce is only in MessageSent.
const DEPOSIT_FOR_BURN_EVENT_TOPIC = '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5'

/**
 * Keccak256 hash function using ethers.js
 * Returns hex string without 0x prefix (to match backend behavior)
 */
function keccak256(data: Uint8Array): string {
  const hash = ethers.keccak256(ethers.hexlify(data))
  // Remove 0x prefix to match backend format
  return hash.slice(2)
}

export interface MessageSentData {
  irisLookupID: string // Keccak256 hash of MessageSent bytes (hex string without 0x)
  nonce: string // Message nonce (bytes32 hex string, 0x-prefixed)
  sourceDomain: number // Source chain domain ID (uint32)
  destinationDomain: number // Destination chain domain ID (uint32)
  messageBytes: Uint8Array // Raw MessageSent event bytes
  messageBody: Uint8Array // Message body bytes
  destinationCaller: Uint8Array // Destination caller address (32 bytes)
}

export interface MessageSentExtractionResult {
  success: boolean
  data?: MessageSentData
  error?: string
}

export interface AttestationResponse {
  attestation: string // Hex-encoded attestation (when complete)
  status: 'pending_confirmations' | 'complete'
}

/** CCTP v2 Iris API response format */
export interface IrisV2Response {
  messages: Array<{
    attestation: string
    message: string
    status: string
  }>
}

export interface IrisPollingParams {
  txHash: string
  chainId: string
  flowId: string
  timeoutMs: number
  pollIntervalMs: number
  requestTimeoutMs?: number
  abortSignal?: AbortSignal
  /** CCTP source domain (required for v2 API) */
  sourceDomain?: number
}

export interface IrisPollingResult {
  success: boolean
  attestation?: string // Hex-encoded attestation (when complete)
  irisLookupID?: string
  nonce?: string
  /** Full attested message from Iris API (contains the real nonce filled in by attestation service) */
  irisMessage?: string
  status?: 'pending_confirmations' | 'complete'
  error?: string
}

/**
 * Create HTTP client for Iris API
 */
function createIrisHttpClient(baseURL: string): AxiosInstance {
  // Ensure base URL ends with /
  const normalizedBaseURL = baseURL.endsWith('/') ? baseURL : `${baseURL}/`

  return axios.create({
    baseURL: normalizedBaseURL,
    timeout: 5000, // Default 5s timeout
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

/**
 * Extract MessageSent event from transaction receipt
 */
export async function extractMessageSent(
  txHash: string,
  chainKey: string,
  provider: ethers.JsonRpcProvider,
): Promise<MessageSentExtractionResult> {
  try {
    // Get chain config to find messageTransmitter address
    const chainConfig = await fetchEvmChainsConfig()
    const chain = findChainByKey(chainConfig, chainKey)
    if (!chain) {
      return {
        success: false,
        error: `Chain not found in config: ${chainKey}`,
      }
    }

    const messageTransmitterAddress = chain.contracts?.messageTransmitter
    if (!messageTransmitterAddress) {
      return {
        success: false,
        error: `MessageTransmitter address not configured for chain: ${chainKey}`,
      }
    }

    logger.debug('[IrisAttestation] Extracting MessageSent event from transaction receipt', {
      txHash,
      chainKey,
      messageTransmitterAddress,
    })

    // Get transaction receipt
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!receipt) {
      return {
        success: false,
        error: `Transaction receipt not found for hash: ${txHash}`,
      }
    }

    if (!receipt.logs || receipt.logs.length === 0) {
      return {
        success: false,
        error: `No logs found in transaction receipt`,
      }
    }

    // Find MessageSent event log
    // MessageSent event has:
    // - topics[0] = event signature hash
    // - data = ABI-encoded bytes message
    const messageTransmitterAddressLower = messageTransmitterAddress.toLowerCase()
    let messageSentLog: ethers.Log | undefined

    // First, try to find MessageSent from MessageTransmitter address (expected location)
    for (const log of receipt.logs) {
      const logAddress = log.address?.toLowerCase()
      if (
        logAddress === messageTransmitterAddressLower &&
        log.topics?.[0] === MESSAGE_SENT_EVENT_TOPIC
      ) {
        messageSentLog = log
        break
      }
    }

    // If not found at expected address, search ALL logs for MessageSent event topic
    // This handles cases where the event might be emitted from a different address
    // (e.g., if config has wrong address, or proxy pattern is used)
    if (!messageSentLog) {
      logger.debug('[IrisAttestation] MessageSent not found at MessageTransmitter address, searching all logs', {
        txHash,
        chainKey,
        messageTransmitterAddress,
        totalLogs: receipt.logs.length,
      })

      // Log all unique addresses and event topics for debugging
      const logAddresses = new Set<string>()
      const eventTopics = new Set<string>()
      for (const log of receipt.logs) {
        if (log.address) {
          logAddresses.add(log.address.toLowerCase())
        }
        if (log.topics?.[0]) {
          eventTopics.add(log.topics[0])
        }
      }

      logger.debug('[IrisAttestation] Transaction receipt log analysis', {
        txHash,
        chainKey,
        uniqueAddresses: Array.from(logAddresses),
        uniqueEventTopics: Array.from(eventTopics),
        messageSentTopic: MESSAGE_SENT_EVENT_TOPIC,
        hasMessageSentTopic: eventTopics.has(MESSAGE_SENT_EVENT_TOPIC),
      })

      // Search all logs for MessageSent event topic
      for (const log of receipt.logs) {
        if (log.topics?.[0] === MESSAGE_SENT_EVENT_TOPIC) {
          messageSentLog = log
          logger.warn('[IrisAttestation] MessageSent event found at different address than configured MessageTransmitter', {
            txHash,
            chainKey,
            configuredMessageTransmitter: messageTransmitterAddress,
            actualEventAddress: log.address,
            eventTopic: log.topics[0],
          })
          break
        }
      }
    }

    if (!messageSentLog) {
      // Try fallback: extract nonce from DepositForBurn event
      logger.debug('[IrisAttestation] MessageSent event not found in any log, trying DepositForBurn fallback', {
        txHash,
        chainKey,
        messageTransmitterAddress,
        totalLogs: receipt.logs.length,
      })
      return extractNonceFromDepositForBurn(receipt, chainKey, chain)
    }

    // Decode MessageSent event data
    // The data field contains the ABI-encoded bytes message
    // For dynamic bytes, ABI encoding is: offset (32 bytes) + length (32 bytes) + data
    const dataHex = messageSentLog.data
    if (!dataHex || dataHex === '0x') {
      return {
        success: false,
        error: 'MessageSent event data is empty',
      }
    }

    logger.debug('[IrisAttestation] Decoding MessageSent event data', {
      txHash,
      chainKey,
      dataHex: dataHex.substring(0, 100) + '...',
      dataLength: dataHex.length,
    })

    // Remove 0x prefix and convert to bytes using ethers (browser-compatible)
    const dataBytes = ethers.getBytes(dataHex)

    // ABI-encoded dynamic bytes: offset (32 bytes) + length (32 bytes) + data
    if (dataBytes.length < 64) {
      logger.error('[IrisAttestation] MessageSent data too short for ABI encoding', {
        txHash,
        chainKey,
        dataBytesLength: dataBytes.length,
        dataHex: dataHex.substring(0, 200),
      })
      return {
        success: false,
        error: `MessageSent data too short: ${dataBytes.length} bytes (need at least 64 for offset + length)`,
      }
    }

    // Read offset (first 32 bytes) - should be 0x20 (32) for single dynamic parameter
    const offsetBytes = dataBytes.slice(0, 32)
    const offset = Number(BigInt(ethers.hexlify(offsetBytes)))

    // Read length (next 32 bytes) as uint256
    const lengthBytes = dataBytes.slice(32, 64)
    const length = Number(BigInt(ethers.hexlify(lengthBytes)))

    logger.debug('[IrisAttestation] Parsed ABI offset and length', {
      txHash,
      chainKey,
      offset,
      length,
      totalDataBytes: dataBytes.length,
    })

    // Extract message bytes (after offset + length = 64 bytes)
    const messageBytes = new Uint8Array(dataBytes.slice(64, 64 + length))

    if (messageBytes.length === 0) {
      logger.error('[IrisAttestation] Message bytes are empty after ABI decoding', {
        txHash,
        chainKey,
        offset,
        length,
        dataBytesLength: dataBytes.length,
        dataHex: dataHex.substring(0, 200),
      })
      return {
        success: false,
        error: `Message bytes are empty (length=${length}, offset=${offset}, dataBytes.length=${dataBytes.length})`,
      }
    }

    logger.debug('[IrisAttestation] Successfully extracted message bytes from ABI-encoded data', {
      txHash,
      chainKey,
      messageBytesLength: messageBytes.length,
    })

    // Parse Message struct
    let message
    try {
      message = parseMessage(messageBytes)
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse Message struct: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // Verify it's a BurnMessage
    try {
      parseBurnMessage(message.messageBody)
    } catch (error) {
      return {
        success: false,
        error: `MessageBody is not a valid BurnMessage: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // Compute IrisLookupID (Keccak256 hash of MessageSent bytes)
    const irisLookupID = keccak256(messageBytes)

    logger.info('[IrisAttestation] Successfully extracted MessageSent event', {
      txHash,
      chainKey,
      irisLookupID,
      nonce: message.nonce,
      sourceDomain: message.sourceDomain,
      destinationDomain: message.destinationDomain,
    })

    return {
      success: true,
      data: {
        irisLookupID,
        nonce: message.nonce,
        sourceDomain: message.sourceDomain,
        destinationDomain: message.destinationDomain,
        messageBytes,
        messageBody: message.messageBody,
        destinationCaller: message.destinationCaller,
      },
    }
  } catch (error) {
    logger.error('[IrisAttestation] Failed to extract MessageSent event', {
      error: error instanceof Error ? error.message : String(error),
      txHash,
      chainKey,
    })
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Fallback: Detect DepositForBurn event existence
 * In CCTP V2, DepositForBurn no longer includes nonce. If MessageSent extraction
 * fails but DepositForBurn exists, we know the burn happened but can't extract nonce.
 */
async function extractNonceFromDepositForBurn(
  receipt: ethers.TransactionReceipt,
  chainKey: string,
  chain: { contracts?: { tokenMessenger?: string } },
): Promise<MessageSentExtractionResult> {
  try {
    const tokenMessengerAddress = chain.contracts?.tokenMessenger

    if (!tokenMessengerAddress || !receipt.logs) {
      return {
        success: false,
        error: 'TokenMessenger address not configured or no logs available',
      }
    }

    const tokenMessengerAddressLower = tokenMessengerAddress.toLowerCase()

    // Find DepositForBurn V2 event
    // V2: DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)
    for (const log of receipt.logs) {
      const logAddress = log.address?.toLowerCase()
      if (
        logAddress === tokenMessengerAddressLower &&
        log.topics?.[0] === DEPOSIT_FOR_BURN_EVENT_TOPIC
      ) {
        logger.info('[IrisAttestation] DepositForBurn V2 event found but nonce not available in this event', {
          chainKey,
        })

        return {
          success: false,
          error: 'MessageSent event not found. DepositForBurn detected but V2 does not include nonce in this event.',
        }
      }
    }

    return {
      success: false,
      error: 'DepositForBurn event not found in transaction receipt',
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to check DepositForBurn: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Poll Iris API for attestation status.
 *
 * Supports two modes:
 * - **v2 (preferred)**: When `sourceDomain` is provided in params, uses
 *   `GET /v2/messages/{sourceDomain}?transactionHash={txHash}`.
 * - **v1 (legacy)**: Falls back to `GET /attestations/{messageHash}`.
 */
export async function pollIrisAttestation(
  params: IrisPollingParams,
  irisLookupID: string,
): Promise<IrisPollingResult> {
  const { flowId, timeoutMs, pollIntervalMs = 3000, requestTimeoutMs = 5000, abortSignal } = params

  // Determine API version based on whether sourceDomain is available
  const useV2 = params.sourceDomain !== undefined

  // Build base URL — strip trailing path segments so we have just the origin
  const configuredBaseUrl = env.irisAttestationBaseUrl()
  // For v2, we need just the origin (e.g., https://iris-api-sandbox.circle.com)
  // The configured URL may be "https://iris-api-sandbox.circle.com/attestations/"
  let baseOrigin: string
  try {
    const parsed = new URL(configuredBaseUrl)
    baseOrigin = parsed.origin
  } catch {
    baseOrigin = configuredBaseUrl.replace(/\/attestations\/?$/, '')
  }

  let fullUrl: string
  if (useV2) {
    fullUrl = `${baseOrigin}/v2/messages/${params.sourceDomain}?transactionHash=${params.txHash}`
  } else {
    // Legacy v1 path
    const lookupID = irisLookupID.startsWith('0x') ? irisLookupID : `0x${irisLookupID}`
    const normalizedBase = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`
    fullUrl = `${normalizedBase}${lookupID}`
  }

  const deadline = Date.now() + timeoutMs
  let attemptCount = 0

  logger.info('[IrisAttestation] Starting iris attestation polling', {
    flowId,
    apiVersion: useV2 ? 'v2' : 'v1',
    url: fullUrl,
    timeoutMs,
    pollIntervalMs,
  })

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      return {
        success: false,
        error: 'Polling aborted',
      }
    }

    attemptCount++

    try {
      logger.debug('[IrisAttestation] Polling iris attestation API', {
        flowId,
        attemptCount,
        url: fullUrl,
      })

      // Create request with timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)

      const response = await axios.get(fullUrl, {
        signal: controller.signal,
        timeout: requestTimeoutMs,
      })

      clearTimeout(timeoutId)

      // Parse response based on API version
      let status: string | undefined
      let attestation: string | undefined
      let irisMessage: string | undefined

      if (useV2) {
        // v2 response: { messages: [{ attestation, message, status }] }
        const v2Data = response.data as IrisV2Response
        const msg = v2Data?.messages?.[0]
        status = msg?.status
        attestation = msg?.attestation
        irisMessage = msg?.message // Full attested message (contains real nonce from attestation service)
      } else {
        // v1 response: { attestation, status }
        const v1Data = response.data as AttestationResponse
        status = v1Data?.status
        attestation = v1Data?.attestation
      }

      logger.debug('[IrisAttestation] Iris API response received', {
        flowId,
        attemptCount,
        status,
        hasAttestation: !!attestation,
        hasIrisMessage: !!irisMessage,
      })

      if (status === 'complete' && attestation) {
        logger.info('[IrisAttestation] Attestation complete', {
          flowId,
          attemptCount,
        })

        return {
          success: true,
          attestation,
          irisMessage,
          irisLookupID: irisLookupID.startsWith('0x') ? irisLookupID : `0x${irisLookupID}`,
          status: 'complete',
        }
      }

      if (status === 'pending_confirmations' || status === 'pending') {
        // Continue polling
        logger.debug('[IrisAttestation] Attestation pending, continuing to poll', {
          flowId,
          attemptCount,
          status,
        })
      } else {
        logger.warn('[IrisAttestation] Unexpected attestation status', {
          flowId,
          attemptCount,
          url: fullUrl,
          status,
        })
      }
    } catch (error) {
      // Handle timeout/abort
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('[IrisAttestation] Iris API request timeout', {
          flowId,
          attemptCount,
          url: fullUrl,
        })
      } else if (axios.isAxiosError(error)) {
        const httpStatus = error.response?.status

        // 404 means attestation not ready yet (still processing)
        if (httpStatus === 404) {
          logger.debug('[IrisAttestation] Attestation not found (still processing)', {
            flowId,
            attemptCount,
            url: fullUrl,
          })
        } else {
          logger.warn('[IrisAttestation] Iris API request failed', {
            flowId,
            attemptCount,
            url: fullUrl,
            status: httpStatus,
            error: error.message,
          })
        }
      } else {
        logger.warn('[IrisAttestation] Iris API request error', {
          flowId,
          attemptCount,
          url: fullUrl,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Wait before next poll (unless we're past deadline)
    if (Date.now() + pollIntervalMs < deadline) {
      await sleep(pollIntervalMs)
    } else {
      break
    }
  }

  logger.warn('[IrisAttestation] Iris attestation polling timed out', {
    flowId,
    attemptCount,
    timeoutMs,
  })

  return {
    success: false,
    irisLookupID: irisLookupID.startsWith('0x') ? irisLookupID : `0x${irisLookupID}`,
    error: `Attestation polling timed out after ${timeoutMs}ms (${attemptCount} attempts)`,
  }
}


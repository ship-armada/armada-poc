/**
 * Orbiter payload service for building CCTP memo payloads for IBC transfers.
 * Handles conversion of EVM addresses to base64-encoded bytes32 format required by Orbiter.
 */

import { env } from '@/config/env'
import { logger } from '@/utils/logger'

export interface OrbiterCctpParams {
  destinationDomain: number
  evmRecipientHex20: string
  evmCallerHex20?: string
}

/**
 * Convert hex string to Uint8Array.
 * Handles hex strings with or without '0x' prefix.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string length')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Left-pad bytes to 32 bytes.
 * Throws error if input is longer than 32 bytes.
 */
function leftPadTo32Bytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new Error('Value longer than 32 bytes')
  }
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

/**
 * Base64 encode Uint8Array.
 * Uses browser's btoa function.
 */
function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  // btoa is available in browsers; for non-browser contexts, callers should polyfill.
  return btoa(binary)
}

/**
 * Base64 decode string to Uint8Array.
 * Uses browser's atob function.
 */
function base64Decode(b64: string): Uint8Array {
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch (error) {
    throw new Error(`Failed to decode base64 string: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Convert Uint8Array to hex string.
 * Removes leading zeros from the result.
 */
function bytesToHex(bytes: Uint8Array, removeLeadingZeros = true): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  if (removeLeadingZeros) {
    // Remove leading zeros but keep at least one character
    hex = hex.replace(/^0+/, '') || '0'
    // Add '0x' prefix
    return '0x' + hex
  }
  return '0x' + hex
}

/**
 * Extract EVM address from bytes32 (last 20 bytes).
 * Removes leading zeros and returns hex string with '0x' prefix.
 */
function bytes32ToEvmHex20(bytes32: Uint8Array): string {
  if (bytes32.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${bytes32.length}`)
  }
  // EVM address is the last 20 bytes (rightmost)
  const addressBytes = bytes32.slice(12, 32)
  return bytesToHex(addressBytes, false)
}

/**
 * Convert EVM hex20 address to base64-encoded bytes32 format.
 * This is required by Orbiter for mint_recipient and destination_caller fields.
 *
 * @param evmHex20 - EVM address in hex format (with or without '0x' prefix)
 * @returns Base64-encoded bytes32 string
 */
export function evmHex20ToBase64Bytes32(evmHex20: string): string {
  try {
    const bytes = hexToBytes(evmHex20)
    const padded = leftPadTo32Bytes(bytes)
    return base64Encode(padded)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[OrbiterPayloadService] Failed to convert EVM address to base64 bytes32', {
      error: errorMessage,
      evmHex20: evmHex20.slice(0, 10) + '...',
    })
    throw error
  }
}

/**
 * Build Orbiter CCTP memo payload for IBC transfers.
 * The payload is included in the IBC memo field to enable Orbiter forwarding.
 *
 * @param params - Orbiter CCTP parameters
 * @returns JSON string of the orbiter memo payload
 */
export function buildOrbiterCctpMemo(params: OrbiterCctpParams): string {
  const { destinationDomain, evmRecipientHex20, evmCallerHex20 } = params

  logger.debug('[OrbiterPayloadService] Building Orbiter CCTP memo', {
    destinationDomain,
    evmRecipientHex20: evmRecipientHex20.slice(0, 10) + '...',
    hasEvmCallerHex20: Boolean(evmCallerHex20),
  })

  // Convert recipient address to base64-encoded bytes32 (required)
  const recipientBytes = leftPadTo32Bytes(hexToBytes(evmRecipientHex20))
  const recipientB64 = base64Encode(recipientBytes)

  // Get destination caller from env var or use provided caller
  // Important: destination_caller defaults to null (not recipient) if not provided
  const envCallerHex = env.paymentDestinationCaller() || ''
  const callerHex =
    evmCallerHex20 && evmCallerHex20.length > 0 ? evmCallerHex20 : envCallerHex

  // Convert caller address to base64-encoded bytes32 (optional, defaults to null)
  const callerB64 =
    callerHex && callerHex.length > 0
      ? base64Encode(leftPadTo32Bytes(hexToBytes(callerHex)))
      : null

  const memo = {
    orbiter: {
      forwarding: {
        protocol_id: 'PROTOCOL_CCTP',
        attributes: {
          '@type': '/noble.orbiter.controller.forwarding.v1.CCTPAttributes',
          destination_domain: destinationDomain,
          mint_recipient: recipientB64,
          destination_caller: callerB64,
        },
        passthrough_payload: '' as string,
      },
    },
  }

  const memoJson = JSON.stringify(memo)

  logger.debug('[OrbiterPayloadService] Orbiter CCTP memo built', {
    destinationDomain,
    hasDestinationCaller: Boolean(callerB64),
    memoLength: memoJson.length,
  })

  return memoJson
}

/**
 * Parsed Orbiter CCTP memo payload.
 */
export interface ParsedOrbiterCctpMemo {
  destinationDomain: number
  evmRecipientHex20: string
  evmCallerHex20: string | null
}

/**
 * Parse and deconstruct Orbiter CCTP memo payload.
 * Extracts destination domain, recipient address, and caller address from the memo.
 *
 * @param memoJson - JSON string of the orbiter memo payload
 * @returns Parsed memo with decoded addresses
 * @throws Error if memo is invalid or cannot be parsed
 */
export function parseOrbiterCctpMemo(memoJson: string): ParsedOrbiterCctpMemo {
  try {
    const memo = JSON.parse(memoJson)

    // Validate structure
    if (!memo?.orbiter?.forwarding?.attributes) {
      throw new Error('Invalid orbiter memo structure: missing required fields')
    }

    const attrs = memo.orbiter.forwarding.attributes

    // Validate protocol
    if (memo.orbiter.forwarding.protocol_id !== 'PROTOCOL_CCTP') {
      throw new Error(`Invalid protocol_id: expected PROTOCOL_CCTP, got ${memo.orbiter.forwarding.protocol_id}`)
    }

    // Validate type
    if (attrs['@type'] !== '/noble.orbiter.controller.forwarding.v1.CCTPAttributes') {
      throw new Error(`Invalid @type: expected /noble.orbiter.controller.forwarding.v1.CCTPAttributes, got ${attrs['@type']}`)
    }

    // Extract destination domain
    const destinationDomain = attrs.destination_domain
    if (typeof destinationDomain !== 'number') {
      throw new Error(`Invalid destination_domain: expected number, got ${typeof destinationDomain}`)
    }

    // Decode recipient address (required)
    if (!attrs.mint_recipient || typeof attrs.mint_recipient !== 'string') {
      throw new Error('Invalid mint_recipient: missing or not a string')
    }
    const recipientBytes32 = base64Decode(attrs.mint_recipient)
    const evmRecipientHex20 = bytes32ToEvmHex20(recipientBytes32)

    // Decode caller address (optional, can be null)
    let evmCallerHex20: string | null = null
    if (attrs.destination_caller !== null && attrs.destination_caller !== undefined) {
      if (typeof attrs.destination_caller !== 'string') {
        throw new Error(`Invalid destination_caller: expected string or null, got ${typeof attrs.destination_caller}`)
      }
      const callerBytes32 = base64Decode(attrs.destination_caller)
      evmCallerHex20 = bytes32ToEvmHex20(callerBytes32)
    }

    return {
      destinationDomain,
      evmRecipientHex20,
      evmCallerHex20,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('[OrbiterPayloadService] Failed to parse orbiter memo', {
      error: errorMessage,
      memoLength: memoJson.length,
    })
    throw new Error(`Failed to parse orbiter memo: ${errorMessage}`)
  }
}

/**
 * Verify Orbiter CCTP memo payload matches the expected inputs.
 * This is a sanity check to ensure the payload was encoded correctly.
 *
 * @param memoJson - JSON string of the orbiter memo payload
 * @param expectedParams - Expected parameters to compare against
 * @throws Error if there's any mismatch
 */
export function verifyOrbiterPayload(
  memoJson: string,
  expectedParams: OrbiterCctpParams,
): void {
  logger.debug('[OrbiterPayloadService] Verifying orbiter payload', {
    destinationDomain: expectedParams.destinationDomain,
    evmRecipientHex20: expectedParams.evmRecipientHex20.slice(0, 10) + '...',
    hasEvmCallerHex20: Boolean(expectedParams.evmCallerHex20),
  })

  // Parse the memo
  const parsed = parseOrbiterCctpMemo(memoJson)

  // Normalize addresses for comparison (lowercase, ensure '0x' prefix)
  const normalizeAddress = (addr: string): string => {
    const clean = addr.startsWith('0x') ? addr.slice(2) : addr
    return '0x' + clean.toLowerCase()
  }

  const expectedRecipient = normalizeAddress(expectedParams.evmRecipientHex20)
  const parsedRecipient = normalizeAddress(parsed.evmRecipientHex20)

  // Determine expected caller
  const envCallerHex = env.paymentDestinationCaller() || ''
  const expectedCallerHex =
    expectedParams.evmCallerHex20 && expectedParams.evmCallerHex20.length > 0
      ? expectedParams.evmCallerHex20
      : envCallerHex
  const expectedCaller = expectedCallerHex && expectedCallerHex.length > 0
    ? normalizeAddress(expectedCallerHex)
    : null

  // Verify destination domain
  if (parsed.destinationDomain !== expectedParams.destinationDomain) {
    const error = `Destination domain mismatch: expected ${expectedParams.destinationDomain}, got ${parsed.destinationDomain}`
    logger.error('[OrbiterPayloadService] Payload verification failed', { error })
    throw new Error(error)
  }

  // Verify recipient address
  if (parsedRecipient !== expectedRecipient) {
    const error = `Recipient address mismatch: expected ${expectedRecipient}, got ${parsedRecipient}`
    logger.error('[OrbiterPayloadService] Payload verification failed', { error })
    throw new Error(error)
  }

  // Verify caller address
  const parsedCaller = parsed.evmCallerHex20 ? normalizeAddress(parsed.evmCallerHex20) : null
  if (parsedCaller !== expectedCaller) {
    const error = `Caller address mismatch: expected ${expectedCaller || 'null'}, got ${parsedCaller || 'null'}`
    logger.error('[OrbiterPayloadService] Payload verification failed', { error })
    throw new Error(error)
  }

  logger.debug('[OrbiterPayloadService] Payload verification successful', {
    destinationDomain: parsed.destinationDomain,
    recipient: parsedRecipient.slice(0, 10) + '...',
    caller: parsedCaller ? parsedCaller.slice(0, 10) + '...' : 'null',
  })
}


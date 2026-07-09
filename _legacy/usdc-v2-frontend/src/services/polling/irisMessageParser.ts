/**
 * Parser for CCTP Message and BurnMessage structures
 * Based on noble-cctp-relayer/types/message.go
 * Ported from usdc-v2-backend/src/modules/iris-attestation/messageParser.ts
 */

/**
 * Parses a MessageV2 struct from raw bytes
 * CCTP V2 Message structure (matches Circle's MessageTransmitterV2):
 * - Version: uint32 (4 bytes, offset 0)
 * - SourceDomain: uint32 (4 bytes, offset 4)
 * - DestinationDomain: uint32 (4 bytes, offset 8)
 * - Nonce: bytes32 (32 bytes, offset 12)
 * - Sender: bytes32 (32 bytes, offset 44)
 * - Recipient: bytes32 (32 bytes, offset 76)
 * - DestinationCaller: bytes32 (32 bytes, offset 108)
 * - MinFinalityThreshold: uint32 (4 bytes, offset 140)
 * - FinalityThresholdExecuted: uint32 (4 bytes, offset 144)
 * - MessageBody: variable length (starts at offset 148)
 */
export function parseMessage(bytes: Uint8Array): {
  version: number
  sourceDomain: number
  destinationDomain: number
  nonce: string
  sender: Uint8Array
  recipient: Uint8Array
  destinationCaller: Uint8Array
  messageBody: Uint8Array
} {
  if (bytes.length < 148) {
    throw new Error(`Message too short: ${bytes.length} bytes, need at least 148`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const version = view.getUint32(0, false) // Big-endian
  const sourceDomain = view.getUint32(4, false)
  const destinationDomain = view.getUint32(8, false)

  // Nonce is bytes32 (32 bytes) at offset 12 in V2
  // Return as 0x-prefixed hex string (real CCTP V2 nonces are arbitrary bytes32, too large for JS number)
  const nonceBytes = bytes.slice(12, 44)
  const nonce = '0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('')

  const sender = bytes.slice(44, 76)
  const recipient = bytes.slice(76, 108)
  const destinationCaller = bytes.slice(108, 140)
  const messageBody = bytes.slice(148)

  return {
    version,
    sourceDomain,
    destinationDomain,
    nonce,
    sender,
    recipient,
    destinationCaller,
    messageBody,
  }
}

/**
 * Parses a BurnMessageV2 struct from MessageBody bytes
 * BurnMessageV2 structure (CCTP V2):
 * - Version: uint32 (4 bytes, offset 0)
 * - BurnToken: bytes32 (32 bytes, offset 4)
 * - MintRecipient: bytes32 (32 bytes, offset 36)
 * - Amount: uint256 (32 bytes, offset 68)
 * - MessageSender: bytes32 (32 bytes, offset 100)
 * - MaxFee: uint256 (32 bytes, offset 132)
 * - FeeExecuted: uint256 (32 bytes, offset 164)
 * - ExpirationBlock: uint256 (32 bytes, offset 196)
 * - HookData: variable length (starts at offset 228)
 * Total minimum length: 228 bytes
 *
 * We only parse the first 132 bytes (common fields) for backward compatibility.
 */
export function parseBurnMessage(bytes: Uint8Array): {
  version: number
  burnToken: Uint8Array
  mintRecipient: Uint8Array
  amount: bigint
  messageSender: Uint8Array
} {
  if (bytes.length < 132) {
    throw new Error(`BurnMessage must be at least 132 bytes, got ${bytes.length}`)
  }

  // Extract only the first 132 bytes (BurnMessage structure)
  // Additional bytes beyond 132 are ignored (may be padding or future fields)
  const burnMessageBytes = bytes.slice(0, 132)

  const view = new DataView(
    burnMessageBytes.buffer,
    burnMessageBytes.byteOffset,
    burnMessageBytes.byteLength,
  )

  const version = view.getUint32(0, false)

  // BurnToken is at offset 4, but we need to extract the address (last 20 bytes of 32-byte slot)
  const burnToken = burnMessageBytes.slice(12, 32) // Last 20 bytes of the 32-byte slot

  const mintRecipient = burnMessageBytes.slice(36, 68)

  // Amount is uint256 (big-endian) at offset 68
  const amountBytes = burnMessageBytes.slice(68, 100)
  const amount = BigInt(
    '0x' +
      Array.from(amountBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
  )

  // MessageSender is at offset 100, extract address (last 20 bytes)
  const messageSender = burnMessageBytes.slice(108, 128) // Last 20 bytes of the 32-byte slot

  return {
    version,
    burnToken,
    mintRecipient,
    amount,
    messageSender,
  }
}


/**
 * Parser for CCTP Message and BurnMessage structures
 * Based on noble-cctp-relayer/types/message.go
 * Ported from usdc-v2-backend/src/modules/iris-attestation/messageParser.ts
 */

/**
 * Parses a Message struct from raw bytes
 * Message structure (from CCTP contracts):
 * - Version: uint32 (4 bytes, offset 0)
 * - SourceDomain: uint32 (4 bytes, offset 4)
 * - DestinationDomain: uint32 (4 bytes, offset 8)
 * - Nonce: uint64 (8 bytes, offset 12)
 * - Sender: bytes32 (32 bytes, offset 20)
 * - Recipient: bytes32 (32 bytes, offset 52)
 * - DestinationCaller: bytes32 (32 bytes, offset 84)
 * - MessageBody: variable length (starts at offset 116)
 */
export function parseMessage(bytes: Uint8Array): {
  version: number
  sourceDomain: number
  destinationDomain: number
  nonce: number
  sender: Uint8Array
  recipient: Uint8Array
  destinationCaller: Uint8Array
  messageBody: Uint8Array
} {
  if (bytes.length < 116) {
    throw new Error(`Message too short: ${bytes.length} bytes, need at least 116`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const version = view.getUint32(0, false) // Big-endian
  const sourceDomain = view.getUint32(4, false)
  const destinationDomain = view.getUint32(8, false)

  // Nonce is uint64 at offset 12
  const nonceHigh = view.getUint32(12, false)
  const nonceLow = view.getUint32(16, false)
  const nonce = Number((BigInt(nonceHigh) << 32n) | BigInt(nonceLow))

  const sender = bytes.slice(20, 52)
  const recipient = bytes.slice(52, 84)
  const destinationCaller = bytes.slice(84, 116)
  const messageBody = bytes.slice(116)

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
 * Parses a BurnMessage struct from MessageBody bytes
 * BurnMessage structure:
 * - Version: uint32 (4 bytes, offset 0)
 * - BurnToken: address (20 bytes, offset 4) - padded to 32 bytes
 * - MintRecipient: bytes32 (32 bytes, offset 36)
 * - Amount: uint256 (32 bytes, offset 68)
 * - MessageSender: address (20 bytes, offset 100) - padded to 32 bytes
 * Total length: 132 bytes
 *
 * Note: MessageBody may contain additional data beyond the BurnMessage (e.g., 140 bytes total),
 * so we parse only the first 132 bytes as the BurnMessage.
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


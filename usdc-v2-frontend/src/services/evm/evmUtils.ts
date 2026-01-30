import { bech32 } from 'bech32'

export function formatEvmAddress(address?: string): string {
  if (!address) return '—'
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function parseAmount(amount: string): bigint {
  // TODO: Integrate decimal conversion using USDC token decimals (6).
  return BigInt(Math.floor(Number(amount) * 1_000_000))
}

/**
 * Encodes a Noble bech32 address to bytes32 format for CCTP contract calls.
 * @param bech32Address - The Noble bech32 address (e.g., 'noble1...')
 * @returns The bytes32 encoded address as a hex string (e.g., '0x...')
 * @throws Error if address cannot be decoded
 */
export function encodeBech32ToBytes32(bech32Address: string): string {
  try {
    const decoded = bech32.decode(bech32Address)
    const raw = bech32.fromWords(decoded.words)
    const bytes = new Uint8Array(raw)
    const padded = new Uint8Array(32)
    padded.set(bytes, 32 - bytes.length)
    return '0x' + Array.from(padded).map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch (error) {
    throw new Error(`Failed to encode bech32 address to bytes32: ${error instanceof Error ? error.message : String(error)}`)
  }
}

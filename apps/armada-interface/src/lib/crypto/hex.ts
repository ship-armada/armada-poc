// ABOUTME: Dependency-free hex <-> bytes codec shared by the crypto modules (kdf, cache-cipher) and
// ABOUTME: the paste-secret path. Uses an explicit nibble decoder instead of parseInt on key-material hex.

/** Lowercase hex string, no `0x` prefix. */
export function bytesToHexNoPrefix(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0')
  }
  return s
}

/**
 * Decode a hex string (optional `0x`/`0X` prefix) to bytes. Throws on odd length or a non-hex
 * character. Uses an explicit nibble decoder rather than `parseInt(slice, 16)` — `parseInt` would
 * silently accept embedded sign characters / whitespace and is a lint-flagged footgun on the
 * key-material paths this codec serves.
 */
export function hexToBytesNoPrefix(hex: string): Uint8Array {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (s.length % 2 !== 0) throw new Error('hex string must have even length')
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error('invalid hex characters')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    const hi = hexNibble(s.charCodeAt(i * 2))
    const lo = hexNibble(s.charCodeAt(i * 2 + 1))
    out[i] = (hi << 4) | lo
  }
  return out
}

function hexNibble(charCode: number): number {
  if (charCode >= 48 && charCode <= 57) return charCode - 48 // '0'-'9'
  if (charCode >= 97 && charCode <= 102) return charCode - 87 // 'a'-'f'
  if (charCode >= 65 && charCode <= 70) return charCode - 55 // 'A'-'F'
  throw new Error('invalid hex character')
}

// ABOUTME: Address-format helpers — validators for EVM (0x…) and shielded (0zk…) recipient strings.
// ABOUTME: No React. Uses ethers (allowed in lib/) for EIP-55 checksum verification of mixed-case EVM addresses.

import { getAddress } from 'ethers'

const EVM_SHAPE = /^0x[a-fA-F0-9]{40}$/

/** Categorised EVM-address validation error. */
export type EvmAddressError = 'shape' | 'checksum'

export interface EvmAddressValidation {
  valid: boolean
  error?: EvmAddressError
}

/**
 * Validate an EVM address, including its EIP-55 checksum when one is present.
 *
 * Shape: `0x` + 40 hex. When the address is MIXED-case (contains both upper- and lower-case hex
 * letters) it carries an EIP-55 checksum, so we verify it via `ethers.getAddress()` and reject a
 * mismatch (`'checksum'`) — that catches a single mistyped or transposed character that a pure
 * shape check would wave through. All-lowercase / all-uppercase addresses carry no checksum (users
 * routinely paste raw-lowercase), so those are accepted on shape alone. Whitespace is trimmed.
 */
export function validateEvmAddress(value: string): EvmAddressValidation {
  const v = value.trim()
  if (!EVM_SHAPE.test(v)) return { valid: false, error: 'shape' }
  const hexLetters = v.slice(2).replace(/[^a-zA-Z]/g, '')
  const mixedCase = /[a-z]/.test(hexLetters) && /[A-Z]/.test(hexLetters)
  if (mixedCase) {
    try {
      getAddress(v)
    } catch {
      return { valid: false, error: 'checksum' }
    }
  }
  return { valid: true }
}

/** Boolean convenience over {@link validateEvmAddress} — true only when shape AND checksum pass. */
export function isEvmAddress(value: string): boolean {
  return validateEvmAddress(value).valid
}

/**
 * Fast shielded-address shape pre-filter. Starts with "0zk" followed by ≥32 alphanumeric
 * characters. Synchronous + cheap, suitable for per-keystroke gating. It does NOT verify the
 * bech32m checksum — use {@link validateShieldedAddressStrict} at the submit boundary to catch a
 * typo that this shape check would accept.
 */
export function isShieldedAddress(value: string): boolean {
  return /^0zk[a-zA-Z0-9]{32,}$/.test(value.trim())
}

/**
 * Strict shielded-address validation via the Railgun SDK's `validateRailgunAddress` (bech32m +
 * checksum). Async + dynamic-imported: the SDK is heavy and crashes under jsdom at module load, so
 * it already ships as a lazy chunk (init.ts / wallet.ts) — this adds no entry-chunk weight. The
 * sync `isShieldedAddress` regex stays the per-keystroke fast path; call this once at the
 * form-validation / submit boundary to reject a 0zk recipient whose checksum doesn't validate
 * (a transposed character that the shape regex would otherwise wave funds through to).
 */
export async function validateShieldedAddressStrict(value: string): Promise<boolean> {
  const v = value.trim()
  // Fast pre-filter: avoid loading the SDK chunk for obviously-malformed input.
  if (!isShieldedAddress(v)) return false
  const { validateRailgunAddress } = await import('@railgun-community/wallet')
  return validateRailgunAddress(v)
}

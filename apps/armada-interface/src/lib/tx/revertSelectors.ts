// ABOUTME: Decodes raw revert payloads (0x<selector>…) for the Solidity-standard errors —
// ABOUTME: Error(string) + Panic(uint256) — so a bare selector doesn't reach ErrorStep undecoded (S-L1).

import { decodeErrorResult, type Hex } from 'viem'

// The protocol's user-facing contracts (PrivacyPool, PrivacyPoolClient, railgun logic, wrappers,
// yield adapter) revert with string `require`s (Error(string)) or hit Solidity's built-in
// Panic(uint256) — they define NO custom errors of their own (those live in the governance
// contracts, which this app never calls directly). So this focused ABI covers every raw selector
// the user tx flows can actually produce; an unknown selector decodes to null and the caller falls
// back to the raw message.
const STANDARD_ERRORS_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const

/** Solidity Panic codes (https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require). */
const PANIC_REASONS: Readonly<Record<string, string>> = {
  '1': 'Assertion failed.',
  '17': 'Arithmetic overflow or underflow.',
  '18': 'Division or modulo by zero.',
  '33': 'Invalid enum value.',
  '34': 'Incorrectly encoded storage byte array.',
  '49': 'Pop on an empty array.',
  '50': 'Array index out of bounds.',
  '65': 'Allocated too much memory or created an oversized array.',
  '81': 'Called an uninitialized internal function.',
}

/**
 * Decode a raw revert-data payload into a friendly message. Handles the two Solidity-standard
 * errors; returns null for anything else (unknown custom-error selector, malformed/short data) so
 * the caller can fall back to the raw message rather than show a misleading decode.
 */
export function decodeRevertData(data: string): string | null {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return null
  try {
    const decoded = decodeErrorResult({ abi: STANDARD_ERRORS_ABI, data: data as Hex })
    if (decoded.errorName === 'Error') {
      return String(decoded.args[0])
    }
    if (decoded.errorName === 'Panic') {
      const code = (decoded.args[0] as bigint).toString()
      return PANIC_REASONS[code] ?? `Contract panic (code ${code}).`
    }
  } catch {
    return null
  }
  return null
}

/**
 * Pull a revert-data hex payload from a thrown error. viem surfaces it on `.data` (or a nested
 * `.cause.data`); some providers embed it in the message as a bare `0x…`. Walks the cause chain a
 * bounded depth so a malformed cycle can't spin.
 */
export function extractRevertHex(err: unknown): string | null {
  let cur: unknown = err
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth++) {
    const data = (cur as { data?: unknown }).data
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data
    cur = (cur as { cause?: unknown }).cause
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const match = msg.match(/0x[0-9a-fA-F]{8,}/)
  return match ? match[0] : null
}

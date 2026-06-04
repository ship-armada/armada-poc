// ABOUTME: Address + ENS input sanitization helpers — trim, charset, length, checksum validation.
// ABOUTME: Shared between SlotCard's invite-recipient input and any future address-entry surface.

import { getAddress } from 'ethers'

/** Longest realistic ENS name we'll accept; well above any practical case
 * and short enough that a paste of garbage gets clipped early. */
export const ADDRESS_INPUT_MAX_LENGTH = 80

/** Trim whitespace and cap length so a wandering paste can't pollute downstream
 * regex / contract calls. Does NOT lowercase — checksum validation needs the
 * original casing. */
export function sanitizeAddressInput(raw: string): string {
  return raw.trim().slice(0, ADDRESS_INPUT_MAX_LENGTH)
}

/** Strict format check — `0x` + exactly 40 hex chars. Does NOT verify the
 * EIP-55 checksum (that's `tryGetChecksumAddress`). */
export function isHexAddressFormat(val: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(val)
}

/** Validate EIP-55 checksum via ethers' `getAddress`. Returns the canonical
 * checksummed form on success, `null` on bad checksum / bad format. An
 * all-lowercase or all-uppercase address is accepted (ethers normalizes it). */
export function tryGetChecksumAddress(val: string): string | null {
  if (!isHexAddressFormat(val)) return null
  try {
    return getAddress(val)
  } catch {
    return null
  }
}

/** Strict ENS-name check for the subset we resolve in the app: lowercase
 * labels separated by dots, each label `[a-z0-9-]` (no leading / trailing
 * hyphen), must end with `.eth`, at least one label before `.eth`. Rejects
 * uppercase, whitespace, emoji, IDN — out of scope for the invite flow. */
export function isValidEnsName(val: string): boolean {
  if (!val.endsWith('.eth')) return false
  if (val.length <= 4 || val.length > ADDRESS_INPUT_MAX_LENGTH) return false
  const labels = val.split('.')
  if (labels.length < 2) return false
  if (labels[labels.length - 1] !== 'eth') return false
  const labelRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
  for (const label of labels) {
    if (!labelRe.test(label)) return false
  }
  return true
}

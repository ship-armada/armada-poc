// ABOUTME: Module-scope private state for the unlocked wallet — root_secret, walletId, sdkEncryptionKey, railgunAddress, checksum.
// ABOUTME: Never exposed to React state, atoms, or localStorage. Cleared on lock; best-effort fill(0) on the root_secret buffer.

import { antiPhishChecksumBytes, formatChecksumDisplay } from '@/lib/crypto/kdf'

interface UnlockedState {
  /** 32-byte root_secret. Kept here so re-derivation isn't needed on each tx. */
  rootSecret: Uint8Array
  /** Cached walletId for fast SDK calls. Persisted via localStorage separately. */
  walletId: string
  /** 64-hex SDK encryption key, derived from rootSecret. */
  sdkEncryptionKey: string
  /** Display-format anti-phish checksum ("a3f2 91c8 b7e0"). */
  checksum: string
  /** The 0zk… address returned by the SDK. */
  railgunAddress: string
  /**
   * Hub-chain block at which the wallet was first enrolled. Captured at true first-enrollment,
   * preserved across backups via the encrypted payload, and threaded into the Railgun SDK's
   * `creationBlockNumbers` on every wallet recreation so the merkletree scan starts at the
   * correct tree position rather than at chain head (which would silently truncate the user's
   * commitment scan to the recent past).
   *
   * `null` means "not known in this session" — happens on paste-secret restores and on the
   * post-load-failure fallback paths in enroll/unlock. `exportBackup` writes 0 in the blob for
   * a null in-session value, and the next restore from that blob will fall back to a full
   * chain rescan (correct, slow).
   */
  creationBlock: number | null
  /**
   * The EVM address this unlock is bound to. Set by signIn() to the connected wagmi address;
   * set by paste/backup unlock paths to the EVM address connected at the time of unlock (so
   * subsequent account-switch detection still works). `null` only when the unlock happened
   * with no EVM wallet connected at all — rare; account-switch detection is a no-op in that
   * case (`useWallet` compares against null and matches).
   *
   * Lowercase-normalized to match the per-EVM-address localStorage map keys. wagmi returns
   * checksummed addresses; we lowercase here at the boundary and never round-trip the
   * checksummed form so map lookups never miss due to case.
   */
  evmAddress: `0x${string}` | null
  /**
   * BIP-44-style account index used to derive this wallet. v1 UI exposes only `0n`; the
   * plumbing supports N ≥ 0 for future multi-identity-per-EVM-wallet (each value of `account`
   * produces a different signature → different root_secret → different shielded identity).
   */
  account: bigint
}

let unlocked: UnlockedState | null = null

/**
 * Mark the wallet as unlocked. Takes ownership of the `rootSecret` buffer — callers should not
 * retain or reuse the passed Uint8Array after handing it over. `clear()` zeroizes it.
 */
export function setUnlocked(s: UnlockedState): void {
  if (s.rootSecret.length !== 32) {
    throw new Error('keyManager.setUnlocked: rootSecret must be 32 bytes')
  }
  unlocked = s
}

export function isUnlocked(): boolean {
  return unlocked !== null
}

/** Throws if locked. */
export function getRootSecret(): Uint8Array {
  if (!unlocked) throw new Error('keyManager: wallet is locked')
  return unlocked.rootSecret
}

export function getWalletId(): string {
  if (!unlocked) throw new Error('keyManager: wallet is locked')
  return unlocked.walletId
}

export function getSdkEncryptionKey(): string {
  if (!unlocked) throw new Error('keyManager: wallet is locked')
  return unlocked.sdkEncryptionKey
}

export function getRailgunAddress(): string {
  if (!unlocked) throw new Error('keyManager: wallet is locked')
  return unlocked.railgunAddress
}

export function getChecksum(): string {
  if (!unlocked) throw new Error('keyManager: wallet is locked')
  return unlocked.checksum
}

/** Returns the in-session creationBlock, or null if not known. Does NOT throw when locked
 *  by design — exportBackup needs to consult this value defensively. Callers that strictly
 *  need a value should treat null as "scan from genesis". */
export function getCreationBlock(): number | null {
  return unlocked?.creationBlock ?? null
}

/**
 * Returns the EVM address this unlock is bound to. Does NOT throw when locked — the wagmi
 * account-change effect in `useWallet` consults this value defensively before deciding whether
 * to auto-lock. Callers receive `null` when either the wallet is locked OR the unlock happened
 * with no EVM wallet connected.
 *
 * Always lowercase — wagmi gives checksummed addresses; we normalize at the keyManager boundary
 * so comparisons against a freshly-arrived wagmi address are direct (also lowercased) without
 * the caller having to remember the convention.
 */
export function getEvmAddress(): `0x${string}` | null {
  return unlocked?.evmAddress ?? null
}

/** Returns the account index this unlock is bound to. Same lock-safe semantics as above. */
export function getAccount(): bigint | null {
  return unlocked?.account ?? null
}

/**
 * Re-compute the checksum from the current rootSecret. Used by UI surfaces that need to compare
 * against a stored value (mismatch → possible compromise). Cheap (one SHA256).
 */
export function deriveChecksum(): string {
  if (!unlocked) throw new Error('keyManager: wallet is locked')
  return formatChecksumDisplay(antiPhishChecksumBytes(unlocked.rootSecret))
}

/**
 * Lock the wallet: zeroize the rootSecret buffer and drop all derived state. Best-effort —
 * JavaScript can't guarantee memory zeroing (see specs/TX_SIGNING.md §"Clear-After-Use") but
 * limiting the lifetime of the buffer + the unlocked struct meaningfully reduces leak surface.
 */
export function clear(): void {
  if (unlocked) {
    unlocked.rootSecret.fill(0)
  }
  unlocked = null
}

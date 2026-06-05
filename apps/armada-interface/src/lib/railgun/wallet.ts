// ABOUTME: Signature-derived Railgun wallet lifecycle per specs/TX_SIGNING.md (Phase 1).
// ABOUTME: enrollFromSignature / unlockFromRootSecret / unlockFromBackup / lockWallet / resetWallet. Internal mnemonic shim hidden inside this module.

// The Railgun SDK pulls a chunky transitive dep graph (circomlibjs, etc.) that has trouble
// loading in jsdom. We `import()` the SDK at call time so vitest can load this module without
// instantiating the engine's polyfill surface — pure unit tests stub the SDK at the import
// boundary. Production code pays the dynamic import cost once per session on first call.
type RailgunSdk = typeof import('@railgun-community/wallet')
async function railgunSdk(): Promise<RailgunSdk> {
  return import('@railgun-community/wallet')
}
import {
  antiPhishChecksumBytes,
  assertEntropyFloor,
  decryptBackup,
  deriveInternalMnemonic,
  deriveRootSecret,
  deriveSdkEncryptionKeyHex,
  deriveSpendingKeyBytes,
  deriveViewingKeyBytes,
  formatChecksumDisplay,
  type BackupBlob,
} from '@/lib/crypto/kdf'
import { track, trackError } from '@/lib/telemetry'
import {
  clear as clearKeyManager,
  getSdkEncryptionKey as kmGetSdkEncryptionKey,
  getWalletId as kmGetWalletId,
  setUnlocked,
} from './keyManager'
import { initRailgunEngine } from './init'
import { getCurrentHubBlock, loadHubNetwork } from './network'

/**
 * Ensure the Railgun engine is initialized + the hub network is loaded before issuing an SDK
 * call. Both are idempotent — first call does the work, subsequent calls return immediately.
 * loadHubNetwork failure is non-fatal during enrollment (the wallet can still be created
 * without a network; balance scanning just won't work until the network is loaded).
 */
async function ensureRailgunReady(): Promise<void> {
  await initRailgunEngine()
  try {
    await loadHubNetwork()
  } catch (err) {
    // Surface but don't block — wallet creation/load doesn't strictly need the network.
    // Balance scans + tx submission will fail downstream until the user fixes the underlying
    // problem (RPC down, contracts not deployed, etc.).
    trackError('railgun.network.load', err, { scope: 'shielded.unlock', message: 'hub network load failed' })
  }
}

/**
 * Public state shape exposed to React (atoms / hooks). No secrets — just identity + status.
 * `id` (walletId) is opaque per Plan §15. `railgunAddress` is the 0zk… form.
 */
export interface ShieldedWalletState {
  readonly id: string
  readonly status: 'locked' | 'unlocked' | 'missing'
  readonly railgunAddress?: string
  /** Anti-phish checksum display string (e.g. "a3f2 91c8 b7e0"). Display-only. */
  readonly checksum?: string
  /** ms timestamp of the most recent successful unlock. */
  readonly unlockedAt?: number
}

/** Persisted across reloads so we can fast-path `loadWalletByID` instead of recreating. */
const STORED_WALLET_ID_KEY = 'armada.shielded.walletId'
/**
 * Persisted alongside the walletId so re-signing can detect a checksum mismatch (spec §
 * "Recovery & re-signing"). The anti-phish checksum is non-secret — safe to store in plaintext.
 * Without this, a second signature from a non-deterministic wallet would silently bind a
 * different identity to the same UI session.
 */
const STORED_CHECKSUM_KEY = 'armada.shielded.checksum'

/**
 * Public lookup — App.tsx uses this on cold boot to seed `shieldedWalletsAtom` with a `locked`
 * entry when a walletId is persisted but the keyManager is (necessarily) empty after reload.
 * Returning null is the signal to route to OnboardingFlow; non-null routes to UnlockFlow.
 */
export function readStoredWalletId(): string | null {
  return storedWalletId()
}

function storedWalletId(): string | null {
  try {
    return window.localStorage.getItem(STORED_WALLET_ID_KEY)
  } catch {
    return null
  }
}
function storeWalletId(id: string): void {
  try {
    window.localStorage.setItem(STORED_WALLET_ID_KEY, id)
  } catch {
    /* silent — quota errors are non-fatal */
  }
}
function clearStoredWalletId(): void {
  try {
    window.localStorage.removeItem(STORED_WALLET_ID_KEY)
    window.localStorage.removeItem(STORED_CHECKSUM_KEY)
  } catch {
    /* silent */
  }
}

/** Dev/UX escape hatch: clear persisted wallet identity (forces onboarding on next boot). */
export function clearStoredWalletIdentity(): void {
  clearStoredWalletId()
}
function storedChecksum(): string | null {
  try {
    return window.localStorage.getItem(STORED_CHECKSUM_KEY)
  } catch {
    return null
  }
}
function storeChecksum(checksum: string): void {
  try {
    window.localStorage.setItem(STORED_CHECKSUM_KEY, checksum)
  } catch {
    /* silent */
  }
}

/**
 * Enrollment from a normalized EIP-712 signature. Derives root_secret, runs IC-2 canary on
 * root + subkey bytes, and unlocks the SDK wallet.
 *
 * Try-load-first semantics: if a walletId is already persisted in localStorage (returning user
 * who re-signed via the UnlockFlow "Sign again" tab, or onboarding that succeeded but the user
 * reloaded mid-ceremony), we load the existing SDK wallet from IDB to preserve its merkle scan
 * cursor + UTXO set. Falling back to `createRailgunWallet` would re-run the wallet's scanner
 * from scratch and (in some SDK code paths) skip already-known commitments — the symptom is
 * "shielded balance shows 0 after reload+sign-again".
 *
 * First-time enrollment (no cached walletId) emits `shielded.created`; returning paths emit
 * `shielded.unlock`.
 *
 * Returns `rootSecret` to the caller because the onboarding flow needs it to drive the backup
 * ceremony. After the user finishes the ceremony the caller is expected to drop its reference;
 * the keyManager retains the authoritative copy until lock or reset.
 *
 * Phase 1 compromise: `deriveInternalMnemonic` produces a deterministic 24-word BIP-39 from
 * root_secret; we hand it to `createRailgunWallet` (or `loadWalletByID`) and never expose it.
 * Phase 2 drops the shim by going through the lower-level engine package.
 */
export async function enrollFromSignature(signatureBytes: Uint8Array): Promise<{
  rootSecret: Uint8Array
  state: ShieldedWalletState
}> {
  await ensureRailgunReady()
  const rootSecret = deriveRootSecret(signatureBytes)
  // IC-2 canaries on root + subkey bytes — catches the bytesToNumber truncation bug class
  // that Privacy Pools shipped. The subkey checks are belt-and-suspenders since these scalars
  // aren't yet handed to the SDK directly (Phase 2 will).
  assertEntropyFloor('root_secret', rootSecret)
  assertEntropyFloor('spending_key', deriveSpendingKeyBytes(rootSecret))
  assertEntropyFloor('viewing_key', deriveViewingKeyBytes(rootSecret))

  const sdkEncryptionKey = deriveSdkEncryptionKeyHex(rootSecret)
  const cachedWalletId = storedWalletId()
  const cachedChecksum = storedChecksum()
  const derivedChecksum = formatChecksumDisplay(antiPhishChecksumBytes(rootSecret))

  // Spec §"Recovery & re-signing": if a wallet is already enrolled and the user re-signs with
  // a non-deterministic wallet, the new signature derives a DIFFERENT root_secret → different
  // identity. We detect that here via the persisted checksum and refuse to clobber the session.
  // Users with deterministic-signing wallets (e.g. Ledger / RFC 6979 conformant) get the
  // happy-path load below; everyone else sees a clear error directing them to paste-secret.
  if (cachedChecksum && derivedChecksum !== cachedChecksum) {
    throw new Error(
      `This signature produces a different identity (${derivedChecksum}) than your stored wallet (${cachedChecksum}). ` +
        'Most wallets produce a different signature every time — re-signing is not a reliable recovery path. ' +
        'Use Paste secret or Backup file instead.',
    )
  }

  let walletId: string
  let railgunAddress: string
  let isFirstTime: boolean
  // Track the creation block we hand to the SDK so we can stash it in the session for
  // exportBackup. null = "not known in this session" — load-from-LevelDB fast-path doesn't need
  // it (the SDK has it in walletDetails); restore-after-cache-loss can't know it.
  let creationBlock: number | null = null

  if (cachedWalletId) {
    // Returning path — try to load the existing SDK wallet first. Preserves scan state + UTXOs.
    try {
      const { loadWalletByID } = await railgunSdk()
      const info = await loadWalletByID(sdkEncryptionKey, cachedWalletId, false /* isViewOnlyWallet */)
      walletId = cachedWalletId
      railgunAddress = info.railgunAddress
      isFirstTime = false
    } catch (err) {
      // Cached id but no entry in this device's IDB (cleared / new device / corrupted state).
      // Recreate deterministically from root_secret. Pass `undefined` for creationBlock — the
      // re-sign path has no way to know the true wallet creation block; using currentHead
      // would silently truncate the SDK's commitment scan to the recent past (the bug v2
      // backups exist to avoid). Slow full rescan is the correct fallback.
      trackError('railgun.wallet.loadByID', err, { scope: 'shielded.enroll', message: 'load failed, recreating' })
      const recreated = await createSdkWalletFromRoot(rootSecret, undefined)
      walletId = recreated.walletId
      railgunAddress = recreated.railgunAddress
      isFirstTime = false // we had a cache; treat as returning even if load failed
    }
  } else {
    // True first-time enrollment — currentBlock IS the wallet's creation block. Capture and
    // persist into the session so exportBackup can write it into the v2 blob.
    const currentBlock = await getCurrentHubBlock()
    creationBlock = currentBlock ?? null
    const fresh = await createSdkWalletFromRoot(rootSecret, currentBlock ?? undefined)
    walletId = fresh.walletId
    railgunAddress = fresh.railgunAddress
    isFirstTime = true
  }

  storeWalletId(walletId)
  storeChecksum(derivedChecksum)
  setUnlocked({
    rootSecret,
    walletId,
    sdkEncryptionKey,
    railgunAddress,
    checksum: derivedChecksum,
    creationBlock,
  })
  if (isFirstTime) {
    track('shielded.created', { walletId })
  } else {
    track('shielded.unlock', { walletId })
  }

  return {
    rootSecret,
    state: {
      id: walletId,
      status: 'unlocked',
      railgunAddress,
      checksum: derivedChecksum,
      unlockedAt: Date.now(),
    },
  }
}

/**
 * Returning-user unlock from a 32-byte root_secret (typically pasted from clipboard / QR or
 * decrypted from an encrypted backup). Same derivation flow as enrollment; loads the SDK
 * wallet from cached walletId when possible, falls back to recreating it (idempotent).
 *
 * `creationBlock` is the hub block at which the wallet was originally enrolled. When supplied
 * (i.e. came out of a decrypted v2 backup), it's threaded to the SDK so the merkletree scan
 * starts at the correct tree position. When undefined (paste-secret path), the SDK runs a full
 * chain rescan — slower but correct.
 */
export async function unlockFromRootSecret(
  rootSecret: Uint8Array,
  creationBlock?: number,
): Promise<ShieldedWalletState> {
  if (rootSecret.length !== 32) {
    throw new Error('unlockFromRootSecret: rootSecret must be 32 bytes')
  }
  await ensureRailgunReady()
  assertEntropyFloor('root_secret', rootSecret)
  assertEntropyFloor('spending_key', deriveSpendingKeyBytes(rootSecret))
  assertEntropyFloor('viewing_key', deriveViewingKeyBytes(rootSecret))

  const sdkEncryptionKey = deriveSdkEncryptionKeyHex(rootSecret)
  let walletId = storedWalletId()
  let railgunAddress: string

  if (walletId) {
    // Try fast-path: existing wallet ID, just load it. The SDK already has the correct
    // creationBlock in walletDetails, so we don't need to pass our copy through here.
    try {
      const { loadWalletByID } = await railgunSdk()
      const info = await loadWalletByID(sdkEncryptionKey, walletId, false /* isViewOnlyWallet */)
      railgunAddress = info.railgunAddress
    } catch (err) {
      // Wallet not in this device's IDB (cleared / new device / corrupted). Fall through to
      // recreate it from the deterministic mnemonic — same root_secret → same walletId.
      trackError('railgun.wallet.loadByID', err, { scope: 'shielded.unlock', message: 'load failed, recreating' })
      const recreated = await createSdkWalletFromRoot(rootSecret, creationBlock)
      walletId = recreated.walletId
      railgunAddress = recreated.railgunAddress
    }
  } else {
    const recreated = await createSdkWalletFromRoot(rootSecret, creationBlock)
    walletId = recreated.walletId
    railgunAddress = recreated.railgunAddress
  }

  const checksum = formatChecksumDisplay(antiPhishChecksumBytes(rootSecret))
  storeWalletId(walletId)
  storeChecksum(checksum)
  setUnlocked({
    rootSecret,
    walletId,
    sdkEncryptionKey,
    railgunAddress,
    checksum,
    // Stash the creationBlock we have (if any) so exportBackup can write a useful value into
    // the next v2 blob. Paste-secret path with no backup-sourced creationBlock yields null →
    // a subsequent exportBackup writes 0 → that backup's restores fall back to full rescan.
    creationBlock: creationBlock ?? null,
  })
  track('shielded.unlock', { walletId })

  return {
    id: walletId,
    status: 'unlocked',
    railgunAddress,
    checksum,
    unlockedAt: Date.now(),
  }
}

/**
 * Returning-user unlock from an encrypted backup blob + the user's backup passphrase. Decrypts
 * the blob to recover both rootSecret and creationBlock, then defers to `unlockFromRootSecret`.
 * `creationBlock === 0` in the blob means "unknown" (set by an exportBackup that had no
 * in-session creationBlock); convert to `undefined` so the SDK falls back to a full chain scan.
 */
export async function unlockFromBackup(blob: BackupBlob, passphrase: string): Promise<ShieldedWalletState> {
  const { rootSecret, creationBlock } = decryptBackup(blob, passphrase)
  return unlockFromRootSecret(rootSecret, creationBlock > 0 ? creationBlock : undefined)
}

/**
 * Drop the unlocked-session state. Does NOT delete the SDK wallet from IDB — only releases
 * the in-memory copies. The user can re-unlock at any time with the same root_secret.
 *
 * Async because we await the SDK's in-memory wallet unload. `_id` is accepted for API
 * consistency with the legacy signature; we always lock whichever wallet is currently unlocked.
 */
export async function lockWallet(_id: string): Promise<void> {
  const id = (() => {
    try {
      return kmGetWalletId()
    } catch {
      return null
    }
  })()
  clearKeyManager()
  if (!id) return
  try {
    const { unloadWalletByID } = await railgunSdk()
    unloadWalletByID(id)
  } catch {
    /* SDK throws if the wallet isn't loaded; ignore. */
  }
  track('shielded.locked', { walletId: id })
}

/**
 * Settings → Reset wallet: lock + delete from the SDK's IDB + drop the cached walletId. After
 * this, the next session starts from enrollment again (with a new EIP-712 sign producing a new
 * root_secret unless the user re-uses an old backup).
 *
 * Throws if no wallet is currently unlocked AND no walletId was cached — there's nothing to
 * reset. UI should disable Reset in that case.
 */
export async function resetWallet(_id: string): Promise<void> {
  let id: string | null = null
  try {
    id = kmGetWalletId()
  } catch {
    id = storedWalletId()
  }
  if (!id) {
    throw new Error('resetWallet: no wallet to reset')
  }
  const sdkEncryptionKey = (() => {
    try {
      return kmGetSdkEncryptionKey()
    } catch {
      return null
    }
  })()
  clearKeyManager()
  // sdkEncryptionKey is captured pre-clear so the SDK delete can run after we've locked the
  // key manager. We don't actually need it for the delete call (SDK signature takes id only)
  // but reading it confirms the session was authenticated. If absent, we still proceed —
  // there's no auth surface on delete to guard.
  void sdkEncryptionKey
  try {
    const { deleteWalletByID } = await railgunSdk()
    await deleteWalletByID(id)
  } catch (err) {
    // Surface but don't block — the wallet may already be absent.
    trackError('railgun.wallet.deleteByID', err, { scope: 'shielded.reset', message: 'delete failed' })
  }
  clearStoredWalletId()
  track('shielded.reset', { walletId: id })
}

/**
 * Internal helper: derive the internal mnemonic + encryption key from root_secret and hand
 * them to the Railgun SDK. The mnemonic exists only on this function's stack frame; the SDK
 * encrypts it before returning. We do not retain the string reference beyond the await.
 *
 * Phase 1 compromise documented in lib/crypto/CLAUDE.md.
 */
async function createSdkWalletFromRoot(
  rootSecret: Uint8Array,
  creationBlock: number | undefined,
): Promise<{
  walletId: string
  railgunAddress: string
}> {
  const sdkEncryptionKey = deriveSdkEncryptionKeyHex(rootSecret)
  const mnemonic = deriveInternalMnemonic(rootSecret)
  // creationBlockNumbers is the SDK's hint for where to begin the merkletree commitment scan.
  // Per the engine source (abstract-wallet.js::getCreationTreeAndPosition), it resolves to a
  // `(creationTree, creationTreeHeight)` position from which the scan walks forward. Pass the
  // TRUE creation block when known (first-enrollment, or restored from v2 backup); pass
  // undefined for restore paths where it's unknown (paste-secret, post-load-failure recovery)
  // and accept the slower full-genesis rescan.
  //
  // Keyed by SDK NetworkName, not chain id. We patch NETWORK_CONFIG.Hardhat to mean our hub
  // chain (see lib/railgun/network.ts), so the key here is literally 'Hardhat'.
  const creationBlockNumbers = creationBlock != null ? { Hardhat: creationBlock } : undefined
  try {
    const { createRailgunWallet } = await railgunSdk()
    const info = await createRailgunWallet(
      sdkEncryptionKey,
      mnemonic,
      creationBlockNumbers,
      0, // railgunWalletDerivationIndex — fixed at 0 for Phase 1 (one identity per spec)
    )
    return { walletId: info.id, railgunAddress: info.railgunAddress }
  } finally {
    // JS strings are immutable; we can't overwrite the buffer. Best we can do is drop the
    // reference. V8 will reclaim it on the next GC cycle. Phase 2 (engine-level) avoids the
    // mnemonic string entirely by writing key bytes directly.
    void mnemonic
  }
}

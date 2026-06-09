// ABOUTME: Signature-derived Railgun wallet lifecycle per specs/TX_SIGNING.md + TX_SIGNING_V2_AMENDMENT.md.
// ABOUTME: enrollFromSignature / unlockFromRootSecret / unlockFromBackup / lockWallet / resetWallet route through a shared applyRootSecret helper. Internal mnemonic shim hidden inside this module.

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
import { NonDeterministicSignerError } from '@/lib/crypto/determinism'
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
 * Shared post-derivation pipeline used by the three rootSecret-bearing entry points
 * (enrollFromSignature / unlockFromRootSecret / unlockFromBackup). Runs IC-2 canaries,
 * fast-paths `loadWalletByID` if a cached id matches, else (re)creates the SDK wallet, persists
 * walletId + checksum to localStorage, and hands the live key material to the keyManager.
 *
 * Telemetry is the caller's responsibility — `applyRootSecret` reports back via `newlyCreated`
 * so each caller can emit the right `shielded.created` vs `shielded.unlock` semantics. (Why not
 * emit here? Because "newly created" is necessary but not sufficient for "first-time
 * enrollment": a re-sign whose cached load fails will *recreate* the SDK wallet, but for the
 * user it's still an unlock, not a new identity.)
 *
 * Caller-supplied `creationBlock` semantics:
 *  - First-time enrollment passes the current hub block (the true wallet birthdate)
 *  - Backup-file unlock passes the value embedded in the v2 blob
 *  - Paste-secret unlock and post-load-failure recovery pass `undefined` (forces a full rescan)
 *
 * Spec compliance: IC-2 entropy-floor canaries on root + both subkey buffers (Phase 1 belt-
 * and-suspenders; the spec mandates the canary on the raw HKDF output of each, pre-reduction).
 */
interface ApplyRootSecretOptions {
  /**
   * Hub block where this wallet was first enrolled. When known (first sign-in or restored from
   * a v2 backup) it's threaded to the SDK's commitment-scan start position. When omitted, the
   * SDK runs a full-genesis scan — correct, just slow.
   */
  readonly creationBlock?: number
}

interface ApplyRootSecretResult {
  readonly state: ShieldedWalletState
  /**
   * True when the SDK wallet was newly created in this call (the cached walletId either didn't
   * exist or failed to load). Callers interpret this against their own "first-time?" context to
   * decide between `shielded.created` and `shielded.unlock` telemetry.
   */
  readonly newlyCreated: boolean
}

async function applyRootSecret(
  rootSecret: Uint8Array,
  opts: ApplyRootSecretOptions = {},
): Promise<ApplyRootSecretResult> {
  // IC-2 canaries on root + subkey bytes — catches the bytesToNumber truncation bug class that
  // Privacy Pools shipped. The subkey checks are belt-and-suspenders since these scalars aren't
  // yet handed to the SDK directly (Phase 2 will use them after field reduction).
  assertEntropyFloor('root_secret', rootSecret)
  assertEntropyFloor('spending_key', deriveSpendingKeyBytes(rootSecret))
  assertEntropyFloor('viewing_key', deriveViewingKeyBytes(rootSecret))

  const sdkEncryptionKey = deriveSdkEncryptionKeyHex(rootSecret)
  const checksum = formatChecksumDisplay(antiPhishChecksumBytes(rootSecret))
  const cachedWalletId = storedWalletId()

  let walletId: string
  let railgunAddress: string
  let newlyCreated: boolean
  // `effectiveCreationBlock` mirrors what we stash into keyManager.creationBlock so a later
  // `exportBackup` can write a meaningful value. null = "not known in this session": the load-
  // fast-path doesn't tell us, since the SDK already has the canonical value in walletDetails.
  let effectiveCreationBlock: number | null = opts.creationBlock ?? null

  if (cachedWalletId) {
    try {
      const { loadWalletByID } = await railgunSdk()
      const info = await loadWalletByID(sdkEncryptionKey, cachedWalletId, false /* isViewOnlyWallet */)
      walletId = cachedWalletId
      railgunAddress = info.railgunAddress
      newlyCreated = false
    } catch (err) {
      // Cached id but no entry in this device's IDB (cleared / new device / corrupted state, or
      // the cached id belonged to a different identity and this rootSecret's sdkEncryptionKey
      // can't decrypt it). Recreate the wallet — same rootSecret deterministically yields the
      // same walletId per the BIP-39 mnemonic shim, so this is idempotent.
      trackError('railgun.wallet.loadByID', err, {
        scope: 'shielded.unlock',
        message: 'load failed, recreating',
      })
      const recreated = await createSdkWalletFromRoot(rootSecret, opts.creationBlock)
      walletId = recreated.walletId
      railgunAddress = recreated.railgunAddress
      newlyCreated = true
    }
  } else {
    const recreated = await createSdkWalletFromRoot(rootSecret, opts.creationBlock)
    walletId = recreated.walletId
    railgunAddress = recreated.railgunAddress
    newlyCreated = true
  }

  storeWalletId(walletId)
  storeChecksum(checksum)
  setUnlocked({
    rootSecret,
    walletId,
    sdkEncryptionKey,
    railgunAddress,
    checksum,
    creationBlock: effectiveCreationBlock,
  })

  return {
    state: {
      id: walletId,
      status: 'unlocked',
      railgunAddress,
      checksum,
      unlockedAt: Date.now(),
    },
    newlyCreated,
  }
}

/**
 * Enrollment / re-sign-in from a normalized EIP-712 signature. Derives root_secret, runs the
 * shared apply pipeline, and emits create-vs-unlock telemetry.
 *
 * Spec V2 amendment: deterministic re-sign is the primary recovery path for compatible EOA
 * wallets. The cached-checksum-mismatch check below catches the case where a wallet *isn't*
 * deterministic (different signature each time → different root_secret → different identity):
 * we refuse to clobber the prior identity and direct the user to paste-secret / backup-file
 * unlock. Phase 2a will replace the inline error message with a typed `NonDeterministicSignerError`
 * the UI can render as a dedicated screen.
 *
 * Returns `rootSecret` to the caller because the onboarding flow needs it for the (now-optional)
 * backup-export ceremony. The keyManager retains the authoritative copy until lock or reset; the
 * caller must NOT mutate or `fill(0)` the returned buffer.
 *
 * Phase 1 compromise: `deriveInternalMnemonic` (called inside `applyRootSecret`'s recreate path)
 * produces a deterministic 24-word BIP-39 from root_secret; we hand it to `createRailgunWallet`
 * and never expose it. Phase 2 drops the shim by going through the lower-level engine package.
 */
export async function enrollFromSignature(signatureBytes: Uint8Array): Promise<{
  rootSecret: Uint8Array
  state: ShieldedWalletState
}> {
  await ensureRailgunReady()
  let rootSecret: Uint8Array
  try {
    rootSecret = deriveRootSecret(signatureBytes)
  } finally {
    // SECURITY (V2 §"Signature discipline"): zero the signature buffer immediately after
    // derivation. The caller's reference points to the same buffer; after this `.fill(0)`
    // any later read sees zeros, which closes the window during which a heap scrape could
    // recover the bytes. Best-effort only — JS gives no zeroization guarantees (V8 may have
    // copied during the HKDF pass), but the discipline is meaningful when followed across
    // the codebase. Inside a `finally` so we cover the assertion-throws-on-bad-length path
    // too.
    signatureBytes.fill(0)
  }

  // Determinism-mismatch guard: if the cached checksum exists and differs from what THIS
  // signature derives, the user's wallet is non-deterministic and re-signing isn't a valid
  // recovery path for them. Throw the typed `NonDeterministicSignerError` so the UI can render
  // the dedicated error screen with the wallet compatibility list + paste/backup fallback CTAs
  // (rather than dumping a stringified Error.message into a generic toast).
  //
  // Note: this is the SUBSEQUENT-sign-in branch (cached identity already exists). The first-
  // ever sign-in's double-sign verification lives in the hook layer where the wagmi signing
  // primitive is available — see useShieldedWallet.ts::signIn.
  const cachedChecksum = storedChecksum()
  const derivedChecksum = formatChecksumDisplay(antiPhishChecksumBytes(rootSecret))
  if (cachedChecksum && derivedChecksum !== cachedChecksum) {
    throw new NonDeterministicSignerError(
      'cached-checksum-mismatch',
      `Signature produces identity ${derivedChecksum} but this device is bound to ${cachedChecksum}. ` +
        'Re-sign recovery requires a deterministic wallet; use Paste recovery secret or Restore from backup file.',
    )
  }

  // First-time enrollment (no cached walletId) sets `creationBlock` to the current hub head so
  // a future exportBackup can write a useful value into the v2 blob. Returning paths leave it
  // unset and accept the slow-rescan fallback if the SDK load fails.
  const wasFirstTimeEnrollment = storedWalletId() == null
  const creationBlock = wasFirstTimeEnrollment ? (await getCurrentHubBlock()) ?? undefined : undefined

  const { state, newlyCreated } = await applyRootSecret(rootSecret, { creationBlock })

  if (wasFirstTimeEnrollment && newlyCreated) {
    track('shielded.created', { walletId: state.id })
  } else {
    track('shielded.unlock', { walletId: state.id })
  }

  return { rootSecret, state }
}

/**
 * Returning-user unlock from a 32-byte root_secret (typically pasted from clipboard / QR or
 * decrypted from an encrypted backup). Delegates to `applyRootSecret` for the shared pipeline;
 * always emits `shielded.unlock` (paste / backup is by definition not a fresh identity).
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
  const { state } = await applyRootSecret(rootSecret, { creationBlock })
  track('shielded.unlock', { walletId: state.id })
  return state
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

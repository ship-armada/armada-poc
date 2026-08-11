// ABOUTME: Signature-derived Railgun wallet lifecycle per specs/TX_SIGNING.md + TX_SIGNING_V2_AMENDMENT.md.
// ABOUTME: enrollFromSignature / unlockFromRootSecret / unlockFromBackup / lockWallet / resetWallet route through a shared applyRootSecret helper. Internal mnemonic shim hidden inside this module.

import { deriveKeyset } from '@armada/sdk'
import {
  antiPhishChecksumBytes,
  assertEntropyFloor,
  decryptBackup,
  deriveHistoryEncryptionKey,
  deriveRootSecret,
  deriveSdkEncryptionKeyHex,
  deriveSpendingKeyBytes,
  deriveViewingKeyBytes,
  deriveWalletId,
  formatChecksumDisplay,
  type BackupBlob,
} from '@/lib/crypto/kdf'
import { NonDeterministicSignerError } from '@/lib/crypto/determinism'
import { track } from '@/lib/telemetry'
import {
  clear as clearKeyManager,
  getWalletId as kmGetWalletId,
  setUnlocked,
} from './keyManager'
import { loadDeployments } from '@/config/deployments'
import { clearHistoryCheckpoint } from './history-checkpoint'
import { deleteSdkReadStorage } from './sdk-read'
import { getCurrentHubBlock } from './network'

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

/**
 * Per-(EVM address, account) walletId + anti-phish-checksum maps.
 *
 * Shape:
 *   armada.shielded.walletIds  = { "0xabc...": { "0": "<walletId>", "1": "<walletId>" }, ... }
 *   armada.shielded.checksums  = { "0xabc...": { "0": "<checksum>", "1": "<checksum>" }, ... }
 *
 * EVM addresses are stored lowercase so map lookups against freshly-arrived wagmi addresses
 * (which are checksummed mixed-case) can normalize at one place and never miss.
 *
 * Account indices are decimal strings because JSON keys are strings; we round-trip through
 * `accountKey(bigint)` so the convention is enforced in one place.
 *
 * Both maps are non-secret: walletId is an opaque SDK identifier (knowing it does not grant
 * access; the encrypted wallet blob in IndexedDB requires sdkEncryptionKey to decrypt), and the
 * checksum is a public anti-phish display string by spec.
 *
 * Schema-version-2 boot wipe (Phase 1) drops the old single-value keys ('armada.shielded.walletId'
 * + 'armada.shielded.checksum'). No code path here reads those legacy keys — first run of v2
 * starts from empty maps.
 */
const STORED_WALLET_IDS_KEY = 'armada.shielded.walletIds'
const STORED_CHECKSUMS_KEY = 'armada.shielded.checksums'

type EvmKey = `0x${string}`
type AccountKey = string
type WalletIdMap = Record<EvmKey, Record<AccountKey, string>>
type ChecksumMap = Record<EvmKey, Record<AccountKey, string>>

function normalizeEvmAddress(addr: `0x${string}`): EvmKey {
  return addr.toLowerCase() as EvmKey
}

function accountKey(account: bigint): AccountKey {
  if (account < 0n) throw new Error('account index must be a non-negative bigint')
  return account.toString(10)
}

function readMap<T extends Record<string, unknown>>(key: string): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {} as T
    const parsed = JSON.parse(raw)
    // Defensive: if the stored value isn't a plain object (corruption, manual tampering), drop
    // it back to empty rather than corrupting downstream lookups with a misshaped read.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T
    }
    return {} as T
  } catch {
    return {} as T
  }
}

function writeMap(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* silent — quota errors are non-fatal */
  }
}

/**
 * Read the cached walletId for a specific (EVM address, account) tuple. Returns null when no
 * sign-in has happened for that pair on this device. Used by the sign-in fast path to skip
 * `createRailgunWallet` and call `loadWalletByID` directly, preserving the SDK's merkle scan
 * cursor + UTXO set across reloads.
 */
export function readStoredWalletIdFor(
  evmAddress: `0x${string}`,
  account: bigint = 0n,
): string | null {
  const map = readMap<WalletIdMap>(STORED_WALLET_IDS_KEY)
  const evm = normalizeEvmAddress(evmAddress)
  return map[evm]?.[accountKey(account)] ?? null
}

/**
 * App.tsx cold-boot probe: does ANY walletId exist on this device?
 *
 * Returns null when the map is empty (route to onboarding) or the first cached walletId we
 * encounter otherwise (route to unlock — App.tsx only needs the existence signal; UnlockFlow's
 * Sign-in tab then asks the user to connect a wallet and looks up the actual entry per
 * (evmAddress, account)).
 *
 * Deterministic-ish order: `Object.keys` returns insertion order, so the first sign-in's address
 * wins. v1 UX is singular so this is "the user's address." Multi-account v2+ can revisit.
 */
export function readStoredWalletId(): string | null {
  const map = readMap<WalletIdMap>(STORED_WALLET_IDS_KEY)
  for (const evm of Object.keys(map)) {
    const accounts = map[evm as EvmKey]
    if (!accounts) continue
    for (const acc of Object.keys(accounts)) {
      const id = accounts[acc]
      if (id) return id
    }
  }
  return null
}

function setStoredWalletId(
  evmAddress: `0x${string}`,
  account: bigint,
  walletId: string,
): void {
  const map = readMap<WalletIdMap>(STORED_WALLET_IDS_KEY)
  const evm = normalizeEvmAddress(evmAddress)
  const entry = map[evm] ?? {}
  entry[accountKey(account)] = walletId
  map[evm] = entry
  writeMap(STORED_WALLET_IDS_KEY, map)
}

/** Lookup checksum for a specific (EVM address, account). Used for cached-mismatch detection. */
export function readStoredChecksumFor(
  evmAddress: `0x${string}`,
  account: bigint = 0n,
): string | null {
  const map = readMap<ChecksumMap>(STORED_CHECKSUMS_KEY)
  const evm = normalizeEvmAddress(evmAddress)
  return map[evm]?.[accountKey(account)] ?? null
}

function setStoredChecksum(
  evmAddress: `0x${string}`,
  account: bigint,
  checksum: string,
): void {
  const map = readMap<ChecksumMap>(STORED_CHECKSUMS_KEY)
  const evm = normalizeEvmAddress(evmAddress)
  const entry = map[evm] ?? {}
  entry[accountKey(account)] = checksum
  map[evm] = entry
  writeMap(STORED_CHECKSUMS_KEY, map)
}

/**
 * Dev/UX escape hatch: clear ALL persisted wallet identities (forces onboarding on next boot).
 * Wipes the full per-(EVM, account) maps — not surgical. Surgical removal isn't exposed because
 * Phase 4's account-switch handler just auto-locks; the user can sign back in for any prior
 * EVM address that's still in the map.
 */
export function clearStoredWalletIdentity(): void {
  try {
    window.localStorage.removeItem(STORED_WALLET_IDS_KEY)
    window.localStorage.removeItem(STORED_CHECKSUMS_KEY)
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
  /**
   * The EVM address this unlock is bound to. Used as the lookup key for the per-(EVM, account)
   * walletId + checksum maps in localStorage. Required by the sign-in path (the connected wagmi
   * address); paste/backup paths pass the *currently connected* EVM address so the resulting
   * binding records who's responsible for the unlock — driving account-switch detection in
   * useWallet.ts.
   *
   * When undefined (no EVM wallet connected — rare edge case), the map fast-path is skipped and
   * the SDK wallet is always recreated from scratch. Functional, just slow on subsequent unlocks.
   */
  readonly evmAddress?: `0x${string}`
  /** BIP-44-style account index. Default 0 (v1 UI only exposes 0). */
  readonly account?: bigint
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

/**
 * Thrown when a paste-secret / backup restore derives an identity that doesn't match the one this
 * device is already bound to for (evmAddress, account). We refuse rather than silently overwriting
 * the localStorage binding maps — a wrong-secret rebind would make the NEXT deterministic sign-in
 * throw a confusing `NonDeterministicSignerError('cached-checksum-mismatch')`. The unlock entry
 * points let this propagate; the UnlockFlow renders `message`. (P1-13)
 */
export class MismatchedRecoverySecretError extends Error {
  readonly boundChecksum: string
  readonly providedChecksum: string
  constructor(boundChecksum: string, providedChecksum: string) {
    super(
      "This recovery secret doesn't match the account previously used on this device. " +
        'Double-check the secret — or reset this device first if you mean to switch to a different wallet.',
    )
    this.name = 'MismatchedRecoverySecretError'
    this.boundChecksum = boundChecksum
    this.providedChecksum = providedChecksum
  }
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
  const account = opts.account ?? 0n

  // Identity-binding guard (P1-13): if this device is already bound to a DIFFERENT identity for
  // (evmAddress, account), refuse before touching the SDK or the binding maps. This stops a wrong
  // pasted secret (or a backup for another wallet) from silently rebinding the device. Sign-in
  // never reaches a mismatch here — enrollFromSignature throws its own typed error first; when the
  // checksums match (or none is stored) this is a no-op. No evmAddress (off-chain paste) → skip.
  if (opts.evmAddress) {
    const boundChecksum = readStoredChecksumFor(opts.evmAddress, account)
    if (boundChecksum && boundChecksum !== checksum) {
      throw new MismatchedRecoverySecretError(boundChecksum, checksum)
    }
  }

  const cachedWalletId = opts.evmAddress
    ? readStoredWalletIdFor(opts.evmAddress, account)
    : null

  // Identity is derived locally — no engine wallet to create or load. `walletId` is a deterministic
  // function of rootSecret; the 0zk address comes from the SDK's keyset derivation (byte-identical to
  // what the read instance derives via `fromRootSecret`). The actual wallet is the persistent
  // @armada/sdk read instance, created lazily on first balance read (sdk-read.ts).
  const walletId = deriveWalletId(rootSecret)
  const railgunAddress = (await deriveKeyset(rootSecret)).railgunAddress
  // "Newly created" (telemetry) = first sign-in on this device for the tuple (no cached id). It no
  // longer implies an engine wallet was created; the identity is purely derived.
  const newlyCreated = cachedWalletId === null
  // Mirrors what we stash into keyManager.creationBlock so a later `exportBackup` can write a
  // meaningful value. null = not known in this session (the SDK read instance resumes from its own
  // persisted checkpoint regardless).
  const effectiveCreationBlock: number | null = opts.creationBlock ?? null

  if (opts.evmAddress) {
    setStoredWalletId(opts.evmAddress, account, walletId)
    setStoredChecksum(opts.evmAddress, account, checksum)
  }
  setUnlocked({
    rootSecret,
    walletId,
    sdkEncryptionKey,
    railgunAddress,
    checksum,
    creationBlock: effectiveCreationBlock,
    evmAddress: opts.evmAddress ? normalizeEvmAddress(opts.evmAddress) : null,
    account,
    historyEncryptionKey: deriveHistoryEncryptionKey(rootSecret),
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
 * Identity is derived entirely locally now — `applyRootSecret` computes the walletId + 0zk address
 * from root_secret (no engine wallet). The actual scanning wallet is the persistent @armada/sdk read
 * instance, created lazily on first balance read.
 */
/**
 * Caller-supplied identity binding for sign-in / unlock entry points. Threading these through
 * the lib lets the per-(EVM, account) localStorage maps key correctly and lets the keyManager
 * record who's bound to the unlock for `useWallet`-driven account-switch detection.
 *
 * Optional everywhere: paths that don't have an EVM address (rare — only when no wallet is
 * connected at all and a paste-restore happens off-chain) gracefully skip the binding and
 * fall back to the always-recreate SDK path.
 */
export interface EnrollOptions {
  readonly evmAddress?: `0x${string}`
  readonly account?: bigint
}

export async function enrollFromSignature(
  signatureBytes: Uint8Array,
  opts: EnrollOptions = {},
): Promise<{
  rootSecret: Uint8Array
  state: ShieldedWalletState
}> {
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

  const account = opts.account ?? 0n

  // Determinism-mismatch guard: if a checksum is cached for THIS (EVM, account) and differs
  // from what the new signature derives, the wallet is non-deterministic for that tuple and
  // re-signing isn't a valid recovery path. Throw the typed `NonDeterministicSignerError` so
  // the UI can render the dedicated error screen with the compatibility list + paste/backup
  // fallback CTAs (rather than dumping a stringified Error.message into a generic toast).
  //
  // Note: this is the SUBSEQUENT-sign-in branch (cached identity already exists for the
  // tuple). The first-ever sign-in's double-sign verification lives in the hook layer where
  // the wagmi signing primitive is available — see useShieldedWallet.ts::signIn.
  const cachedChecksum = opts.evmAddress ? readStoredChecksumFor(opts.evmAddress, account) : null
  const derivedChecksum = formatChecksumDisplay(antiPhishChecksumBytes(rootSecret))
  if (cachedChecksum && derivedChecksum !== cachedChecksum) {
    throw new NonDeterministicSignerError(
      'cached-checksum-mismatch',
      `Signature produces identity ${derivedChecksum} but this device is bound to ${cachedChecksum} for this EVM account. ` +
        'Re-sign recovery requires a deterministic wallet; use Paste recovery secret or Restore from backup file.',
    )
  }

  // First-time enrollment on THIS device (no cached walletId for this tuple) sets
  // `creationBlock` to the hub deploy block — NOT the current head. The earlier value is
  // critical for chain-history recovery: a user who previously enrolled this wallet on another
  // device (or cleared local storage and re-signed) has on-chain activity at blocks prior to
  // "now", and the SDK's merkletree scan starts at `creationBlockNumbers` and skips earlier
  // commitments. Anchoring at the deploy block ensures every shield/transact/unshield this
  // wallet ever authored is discoverable by `getWalletTransactionHistory`.
  // Fallback chain: deploy block from the manifest → current head (older manifests without a
  // deploy block) → undefined (SDK does a full rescan from genesis — slowest but correct).
  // Returning paths (cached walletId exists in localStorage) leave creationBlock undefined so
  // the SDK reuses the value it stored at original creation.
  const wasFirstTimeEnrollment = opts.evmAddress
    ? readStoredWalletIdFor(opts.evmAddress, account) == null
    : true
  const creationBlock = wasFirstTimeEnrollment
    ? await resolveCreationBlock()
    : undefined

  const { state, newlyCreated } = await applyRootSecret(rootSecret, {
    creationBlock,
    evmAddress: opts.evmAddress,
    account,
  })

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
export interface UnlockOptions {
  /** Embedded v2-backup hub creation block, or omitted for paste-secret restores. */
  readonly creationBlock?: number
  /** Currently-connected EVM address — bound to the unlock for account-switch detection. */
  readonly evmAddress?: `0x${string}`
  /** Account index. Default 0. */
  readonly account?: bigint
}

export async function unlockFromRootSecret(
  rootSecret: Uint8Array,
  opts: UnlockOptions = {},
): Promise<ShieldedWalletState> {
  if (rootSecret.length !== 32) {
    throw new Error('unlockFromRootSecret: rootSecret must be 32 bytes')
  }
  const { state } = await applyRootSecret(rootSecret, opts)
  track('shielded.unlock', { walletId: state.id })
  return state
}

/**
 * Returning-user unlock from an encrypted backup blob + the user's backup passphrase. Decrypts
 * the blob to recover both rootSecret and creationBlock, then defers to `unlockFromRootSecret`.
 * `creationBlock === 0` in the blob means "unknown" (set by an exportBackup that had no
 * in-session creationBlock); convert to `undefined` so the SDK falls back to a full chain scan.
 */
export async function unlockFromBackup(
  blob: BackupBlob,
  passphrase: string,
  opts: Omit<UnlockOptions, 'creationBlock'> = {},
): Promise<ShieldedWalletState> {
  const { rootSecret, creationBlock } = await decryptBackup(blob, passphrase)
  return unlockFromRootSecret(rootSecret, {
    ...opts,
    creationBlock: creationBlock > 0 ? creationBlock : undefined,
  })
}

/**
 * Drop the unlocked-session state. Does NOT delete the SDK read instance's persisted scan state —
 * only releases the in-memory secrets. The user can re-unlock at any time with the same root_secret;
 * the @armada/sdk read instance is torn down separately by `useShieldedBalanceSync` on the active-
 * wallet change (which calls `closeSdkRead`). `_id` is accepted for API compatibility with callers.
 *
 * Kept synchronous-first: the tab-unload (`beforeunload`) lock path relies on the rootSecret buffer
 * being zeroized before the page tears down, so `clearKeyManager()` must run before any await.
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
  if (id) track('shielded.locked', { walletId: id })
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
    id = readStoredWalletId()
  }
  if (!id) {
    throw new Error('resetWallet: no wallet to reset')
  }
  clearKeyManager()
  // Wipe the @armada/sdk read instance's persisted scan state (closes it, deletes the read DB) so the
  // next enrollment re-scans from the deploy block. Best-effort — a delete error must not block reset.
  await deleteSdkReadStorage()
  clearStoredWalletIdentity()
  // Drop the history-scan checkpoint so a future re-enrollment on this device walks chain history
  // from the hub deploy block again, not from a stale block that pre-dates the new wallet's activity.
  clearHistoryCheckpoint(id)
  track('shielded.reset', { walletId: id })
}

/**
 * Resolve the `creationBlock` to hand to the SDK for a first-time-on-this-device enrollment.
 * Priority order:
 *
 *   1. `hub.deployBlock` from the deployment manifest — guarantees full chain-history coverage
 *      regardless of when this wallet was originally enrolled or how many cleared-storage
 *      cycles have happened since.
 *   2. `getCurrentHubBlock()` — fallback for legacy manifests that don't carry deployBlock;
 *      preserves the pre-Phase-9 behavior but loses old activity on re-enrollment.
 *   3. `undefined` — SDK falls back to full genesis rescan; slowest but always correct.
 */
async function resolveCreationBlock(): Promise<number | undefined> {
  try {
    const deployments = await loadDeployments()
    if (deployments.hub.deployBlock !== undefined) return deployments.hub.deployBlock
  } catch {
    // Manifest load failed (offline, dev plugin down) — fall through to head-block fallback.
  }
  return (await getCurrentHubBlock()) ?? undefined
}

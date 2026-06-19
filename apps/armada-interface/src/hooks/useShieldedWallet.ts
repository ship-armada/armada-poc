// ABOUTME: Railgun wallet hook — signIn (signature-derived, deterministic v2 primary) + paste/backup unlock + lock/reset/exportBackup.
// ABOUTME: Plural-wallet schema (state/wallet.ts) is future-proofing; v1 UX is singular and the hook hides that.

import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback } from 'react'
import { signTypedData } from 'wagmi/actions'
import {
  activeRailgunWalletIdAtom,
  activeShieldedWalletAtom,
  evmAddressAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { wagmiConfig } from '@/config/wagmi'
import {
  enrollFromSignature,
  lockWallet,
  readStoredWalletIdFor,
  resetWallet,
  unlockFromBackup,
  unlockFromRootSecret,
  type ShieldedWalletState,
} from '@/lib/railgun/wallet'
import {
  getCreationBlock as kmGetCreationBlock,
  getRootSecret as kmGetRootSecret,
} from '@/lib/railgun/keyManager'
import {
  buildEnrollmentTypedData,
  normalizeSignature,
} from '@/lib/crypto/eip712'
import {
  NonDeterministicSignerError,
  verifySignatureDeterminism,
} from '@/lib/crypto/determinism'
import {
  encryptBackup,
  parseBackupBlob,
  type BackupBlob,
} from '@/lib/crypto/kdf'
import { hexToBytesNoPrefix } from '@/lib/crypto/hex'
import { cancelAllRunning, clearResumed } from '@/lib/tx/executor'
import { track, trackError } from '@/lib/telemetry'

/**
 * Hook surface: typed lifecycle actions that wrap `lib/railgun/wallet`. Side effects per call:
 * 1. Calls the lib function (which writes the keyManager singleton)
 * 2. Mirrors the resulting `ShieldedWalletState` into `shieldedWalletsAtom` + `activeRailgunWalletIdAtom`
 * 3. Emits a `track(...)` event on success, `trackError(...)` on failure
 */
export function useShieldedWallet() {
  const active = useAtomValue(activeShieldedWalletAtom)
  const activeId = useAtomValue(activeRailgunWalletIdAtom)
  const evmAddress = useAtomValue(evmAddressAtom)
  const setWallets = useSetAtom(shieldedWalletsAtom)
  const setActiveId = useSetAtom(activeRailgunWalletIdAtom)

  /**
   * Primary unlock path (v2 amendment): build the deterministic EIP-712 message for the given
   * BIP-44-style account index → sign via wagmi → normalize bytes → derive root_secret → SDK
   * load-or-create. The signing prompt is what users see in MetaMask / Rabby / etc; if they
   * reject, the wagmi async call rejects and we propagate.
   *
   * Returns the rootSecret to the caller so the onboarding flow can drive the optional backup-
   * export ceremony. The returned `Uint8Array` is the SAME reference held by the keyManager —
   * UI code MUST NOT mutate or `fill(0)` the buffer; the keyManager owns its lifetime.
   *
   * `account` defaults to 0 (the only value the v1 UI exposes); the plumbing accepts N ≥ 0 so
   * multi-identity-per-EVM-wallet can ship later without another schema fork.
   */
  const signIn = useCallback(async (account: bigint = 0n): Promise<{
    rootSecret: Uint8Array
    state: ShieldedWalletState
  }> => {
    if (!evmAddress) {
      throw new Error('Connect an EVM wallet before signing in.')
    }
    // SECURITY (V2 amendment §"Signature discipline"): the bytes returned by `signTypedData`
    // are the user's wallet's signature over the enrollment EIP-712 message — the entropy
    // source from which root_secret (and every downstream private key) is derived. These bytes:
    //
    //   - MUST NOT be transmitted via `fetch` / `XMLHttpRequest` / `postMessage` / `WebSocket`
    //     or any other off-device primitive. The signature lives in this closure and on the
    //     keyManager's heap, and nowhere else.
    //   - MUST NOT be persisted to localStorage / sessionStorage / IndexedDB / cookies.
    //   - MUST NOT be logged to `console` / telemetry / Sentry / error reporters. The structured
    //     `track`/`trackError` helpers in lib/telemetry.ts are allowlist-typed and won't accept
    //     them; raw `console.*` is banned in lib/railgun/ + lib/crypto/ by convention.
    //   - MUST be discarded immediately after HKDF derivation. `enrollFromSignature` zeros the
    //     buffer internally; the `finally` block below covers the early-return paths where
    //     enrollFromSignature wasn't reached (e.g. determinism check failed and we throw).
    //
    // The ESLint rule that would catch accidental violations is deferred — see plan §4 Phase
    // 2b. Until it lands, code review is the enforcement.
    try {
      const typedData = buildEnrollmentTypedData(account)
      // Capture the wagmi sign call as a closure so the determinism verification can re-invoke
      // the same prompt without us hand-marshaling the typed-data shape twice. The wallet may
      // re-prompt the user; that's intentional and the only way to verify determinism for a
      // wallet we don't yet trust.
      const promptSign = async (): Promise<Uint8Array> => {
        const hex = await signTypedData(wagmiConfig, {
          domain: { ...typedData.domain },
          types: {
            Enrollment: typedData.types.Enrollment.map(f => ({ ...f })),
          },
          primaryType: typedData.primaryType,
          message: { ...typedData.message },
        })
        try {
          return normalizeSignature(hex)
        } catch (err) {
          // ERC-1271 / smart-account wallets (Safe, etc.) return variable-length contract
          // signatures that aren't the 64/65-byte EOA shape our deterministic derivation needs.
          // Route to the dedicated incompatible-signer screen instead of surfacing a raw
          // byte-length error in a generic toast. (P1-17)
          if (err instanceof Error && /expected 64 or 65 byte input/i.test(err.message)) {
            throw new NonDeterministicSignerError(
              'first-sign-mismatch',
              'This wallet returned a signature this app can\'t use for deterministic sign-in ' +
                '(typically a smart-account / ERC-1271 wallet).',
            )
          }
          throw err
        }
      }

      const signatureBytes = await promptSign()
      try {
        // First-ever sign-in for THIS (EVM address, account) tuple is the moment to verify
        // determinism — if we proceeded without checking and the wallet were non-deterministic,
        // the first signature would derive an identity the user could never re-sign back into.
        // Returning users (cached walletId present for this tuple) get their determinism check
        // via the cached-checksum-mismatch guard inside `enrollFromSignature`; we don't double-
        // sign on every unlock because (a) the cached check is cheaper and (b) re-prompting on
        // every visit is hostile UX.
        const evmAddressLc = evmAddress as `0x${string}`
        const isFirstEverSignIn = readStoredWalletIdFor(evmAddressLc, account) == null
        if (isFirstEverSignIn) {
          const { deterministic } = await verifySignatureDeterminism(promptSign, signatureBytes)
          if (!deterministic) {
            throw new NonDeterministicSignerError('first-sign-mismatch')
          }
        }

        const out = await enrollFromSignature(signatureBytes, { evmAddress: evmAddressLc, account })
        setWallets(prev => ({ ...prev, [out.state.id]: out.state }))
        setActiveId(out.state.id)
        // `shielded.created` / `shielded.unlock` is emitted by `enrollFromSignature` itself;
        // don't double-track here.
        return out
      } finally {
        // SECURITY: best-effort zeroize the signature buffer on EVERY exit path. The happy
        // path is already covered (enrollFromSignature zeros it after HKDF); this block
        // closes the gap when the determinism check throws before enrollFromSignature is
        // called, or when enrollFromSignature itself throws BEFORE its own finally fires
        // (it doesn't today, but defense in depth).
        signatureBytes.fill(0)
      }
    } catch (err) {
      trackError('useShieldedWallet.signIn', err, { scope: 'shielded.unlock', message: 'signIn failed' })
      throw err
    }
  }, [evmAddress, setWallets, setActiveId])

  /**
   * Deprecated alias for `signIn(0n)`. Retained so the Phase 3 UI rewrite can flip callers
   * over in one place without a separate Phase 2 sweep through OnboardingFlow* + tests. New
   * code should call `signIn` directly.
   *
   * @deprecated Use `signIn(account?: bigint)` instead.
   */
  const enroll = useCallback(() => signIn(0n), [signIn])

  /**
   * Unlock from a pasted hex-encoded root_secret. Strips an optional `0x` prefix. The 64-hex-char
   * input → 32 bytes → `unlockFromRootSecret`. Hex parsing errors propagate.
   */
  const unlockByPaste = useCallback(async (rootSecretHex: string): Promise<void> => {
    const trimmed = rootSecretHex.trim().replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error('Recovery secret must be 64 hexadecimal characters (32 bytes).')
    }
    // Shared nibble decoder (not parseInt) for key-material hex — see lib/crypto/hex.ts.
    const bytes = hexToBytesNoPrefix(trimmed)
    try {
      // Pass the currently-connected EVM address (if any) so the keyManager records who's bound
      // to this unlock and `useWallet`'s account-switch detection works against paste-restored
      // wallets too. When no wallet is connected (rare — user pastes off-chain), the binding
      // is skipped and account-switch detection becomes a no-op until the next sign-in.
      const next = await unlockFromRootSecret(bytes, {
        evmAddress: (evmAddress ?? undefined) as `0x${string}` | undefined,
        account: 0n,
      })
      setWallets(prev => ({ ...prev, [next.id]: next }))
      setActiveId(next.id)
    } catch (err) {
      trackError('useShieldedWallet.unlockByPaste', err, { scope: 'shielded.unlock', message: 'paste unlock failed' })
      throw err
    } finally {
      // The bytes are still referenced by the keyManager via unlockFromRootSecret; zeroizing our
      // local copy is safe and removes the duplicate from heap.
      bytes.fill(0)
    }
  }, [evmAddress, setWallets, setActiveId])

  /**
   * Unlock from a downloaded backup file + the user's passphrase. Reads the file as text, parses
   * + validates the JSON shape via `parseBackupBlob`, then runs the standard decrypt + unlock.
   */
  const unlockByBackup = useCallback(async (file: File, passphrase: string): Promise<void> => {
    try {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('Backup file is not valid JSON.')
      }
      const blob: BackupBlob = parseBackupBlob(parsed)
      // Same evmAddress-binding rationale as unlockByPaste — record who's responsible for the
      // unlock so account-switch detection covers backup-restored wallets too.
      const next = await unlockFromBackup(blob, passphrase, {
        evmAddress: (evmAddress ?? undefined) as `0x${string}` | undefined,
        account: 0n,
      })
      setWallets(prev => ({ ...prev, [next.id]: next }))
      setActiveId(next.id)
    } catch (err) {
      trackError('useShieldedWallet.unlockByBackup', err, { scope: 'shielded.unlock', message: 'backup unlock failed' })
      throw err
    }
  }, [evmAddress, setWallets, setActiveId])

  /**
   * Export the currently-unlocked wallet's root_secret + creationBlock as an encrypted v2
   * backup blob. The caller is expected to JSON.stringify + download the result. Throws if no
   * wallet is unlocked.
   *
   * `creationBlock` is read from the keyManager session — it was set at enrollment (true value)
   * or carried in from a prior v2 backup unlock. If the session has no creationBlock (paste-
   * secret unlock path), we write `0` into the blob — restores of that blob will fall back to a
   * full chain rescan rather than truncate the SDK's commitment scan to a stale block. Once the
   * paste-restored wallet has finished its full scan, re-exporting a backup remains useful for
   * passphrase rotation; the next restore from THAT blob is still slow until the user enrolls
   * fresh on a deterministic-signing wallet path.
   */
  const exportBackup = useCallback(async (passphrase: string): Promise<BackupBlob> => {
    try {
      const rootSecret = kmGetRootSecret() // throws when locked
      const creationBlock = kmGetCreationBlock() ?? 0
      const blob = await encryptBackup({ rootSecret, creationBlock }, passphrase)
      if (activeId) track('shielded.exported', { walletId: activeId })
      return blob
    } catch (err) {
      trackError('useShieldedWallet.exportBackup', err, { scope: 'shielded.export', message: 'export failed' })
      throw err
    }
  }, [activeId])

  const lock = useCallback(() => {
    if (!activeId) return
    // Flip the atom synchronously — `lockWallet` clears the in-memory key material before its
    // own internal await, so the wallet is effectively locked the moment we drop the keys. The
    // SDK's `unloadWalletByID` is best-effort cleanup; awaiting it would make `lock()` appear
    // async to callers (e.g. the auto-lock timer) that need a synchronous transition.
    setWallets(prev => {
      const existing = prev[activeId]
      if (!existing) return prev
      return { ...prev, [activeId]: { ...existing, status: 'locked' } }
    })
    // Abort in-flight txs BEFORE lockWallet zeroizes the keyManager — terminal cancel/dismiss
    // persists need the historyEncryptionKey (W-5 makes the persist survive the zeroize race, but
    // the cancel itself must still fire while unlocked). Without this, a manual lock mid-flight
    // strands records: writes throw "wallet locked", atom + IDB diverge. (T-M1, mirrors the
    // account-switch path in useWallet.) Then drop the resume guard so a re-unlock in the same
    // session re-attaches watchers instead of being skipped by resumeForWallet's idempotency Set.
    cancelAllRunning('manual-lock')
    clearResumed(activeId)
    lockWallet(activeId).catch(err => {
      trackError('useShieldedWallet.lock', err, { scope: 'shielded.lock', message: 'lock failed' })
    })
  }, [activeId, setWallets])

  const reset = useCallback(async () => {
    if (!activeId) return
    try {
      await resetWallet(activeId)
      setWallets(prev => {
        const next = { ...prev }
        delete next[activeId]
        return next
      })
      setActiveId(null)
    } catch (err) {
      trackError('useShieldedWallet.reset', err, { scope: 'shielded.reset', message: 'reset failed' })
      throw err
    }
  }, [activeId, setWallets, setActiveId])

  return {
    state: active,
    signIn,
    enroll, // deprecated alias for signIn(0n); retained for the Phase 3 UI sweep
    unlockByPaste,
    unlockByBackup,
    exportBackup,
    lock,
    reset,
  }
}

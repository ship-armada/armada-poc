// ABOUTME: Signature-determinism verification + typed NonDeterministicSignerError, per V2 amendment §"Axiom 1 (revised)".
// ABOUTME: Re-sign recovery only works on RFC 6979 deterministic ECDSA wallets; we verify at first sign-in and on every subsequent unlock.

/**
 * Typed error thrown when the user's wallet fails the determinism contract — either:
 *
 *  - **`first-sign-mismatch`** — at first-ever sign-in for an EVM address, we sign the same
 *    EIP-712 message twice and compare bytes. Smart-account wallets, EIP-1271 contract signers,
 *    and any wallet using random `k` for ECDSA produce different bytes each time and trip this
 *    branch. Hard-failing here is correct: if we proceeded, the *first* signature would derive
 *    an identity the user could never re-sign back into.
 *
 *  - **`cached-checksum-mismatch`** — at a subsequent sign-in, the re-derived anti-phish
 *    checksum differs from the one stored at enrollment. This means the wallet *was* deterministic
 *    at enrollment but isn't anymore (rare, e.g. wallet version regression) or — more commonly —
 *    the user has switched to a different EVM account in their wallet UI and the connected
 *    address is the same one wagmi reports but the underlying key has changed. Either way, the
 *    re-sign path can't recover this identity; the user must restore via paste-secret or backup
 *    file.
 *
 * UI rendering: catch via `isNonDeterministicSignerError(err)` and render the dedicated error
 * screen with the wallet compatibility list + "use a backup file or recovery secret instead" CTA.
 * The `reason` discriminator lets us tailor copy ("this wallet doesn't support sign-in" vs "the
 * signature changed — possible compromise") without leaking implementation details.
 *
 * The class identity check (`instanceof`) is supplemented with a `kind` string so detection
 * works across bundle boundaries / dynamic imports / structured-clone-stripped error paths.
 */
export type NonDeterministicSignerErrorReason =
  | 'first-sign-mismatch'
  | 'cached-checksum-mismatch'

export class NonDeterministicSignerError extends Error {
  readonly kind: 'NonDeterministicSignerError' = 'NonDeterministicSignerError'
  readonly reason: NonDeterministicSignerErrorReason

  constructor(reason: NonDeterministicSignerErrorReason, message?: string) {
    super(message ?? defaultMessage(reason))
    this.name = 'NonDeterministicSignerError'
    this.reason = reason
    // Make the prototype chain explicit so `instanceof` works under the Babel/TS class-extending
    // transforms that some test environments apply.
    Object.setPrototypeOf(this, NonDeterministicSignerError.prototype)
  }
}

function defaultMessage(reason: NonDeterministicSignerErrorReason): string {
  switch (reason) {
    case 'first-sign-mismatch':
      return 'This wallet produced two different signatures for the same message. Sign-in requires a deterministic wallet (MetaMask, Rabby, Frame, Ledger, Trezor, Coinbase Wallet). Smart-account wallets are not supported on the sign-in path — use a backup file or recovery secret instead.'
    case 'cached-checksum-mismatch':
      return 'The signature from this wallet now produces a different identity than the one stored on this device. Your wallet may have changed underlying accounts. Sign-in cannot recover the original identity — use Paste recovery secret or Restore from backup file.'
  }
}

/**
 * Type guard. Robust against `instanceof` failures across bundle/realm boundaries by also
 * checking the `kind` discriminator we attach in the constructor. Prefer this over raw
 * `instanceof` in UI catch handlers.
 */
export function isNonDeterministicSignerError(err: unknown): err is NonDeterministicSignerError {
  if (err instanceof NonDeterministicSignerError) return true
  if (typeof err !== 'object' || err === null) return false
  const k = (err as { kind?: unknown }).kind
  return k === 'NonDeterministicSignerError'
}

/**
 * Sign the same EIP-712 message a second time and return whether the signature bytes match.
 *
 * Why a callback rather than holding the wagmi config here: this module is pure crypto with no
 * wagmi dependency. Callers (hooks) pass a closure that invokes `signTypedData(wagmiConfig, ...)`
 * with the same typed data they used for the first sign. The callback should:
 *
 *  - Produce the SAME EIP-712 message bytes both times (caller's responsibility — the v2 schema
 *    is deterministic by design, but the caller still has to pass the same `account` etc).
 *  - Normalize the wallet response to canonical 65-byte `r || s || v` form via
 *    `normalizeSignature`. Comparing pre-normalization bytes risks false negatives on wallets
 *    that return signatures in different encodings between calls (compact 64-byte vs full 65).
 *
 * Returns a plain object so callers can branch on `deterministic` without try/catch. On
 * `deterministic: false`, the caller MUST throw `NonDeterministicSignerError('first-sign-mismatch')`
 * — this function deliberately doesn't throw so it can be unit-tested without try/catch wrapping.
 */
export interface VerifyDeterminismResult {
  readonly deterministic: boolean
}

export async function verifySignatureDeterminism(
  reSign: () => Promise<Uint8Array>,
  firstSignature: Uint8Array,
): Promise<VerifyDeterminismResult> {
  if (firstSignature.length !== 65) {
    throw new Error(`verifySignatureDeterminism: expected 65-byte normalized firstSignature, got ${firstSignature.length}`)
  }
  const secondSignature = await reSign()
  if (secondSignature.length !== 65) {
    throw new Error(`verifySignatureDeterminism: expected 65-byte normalized secondSignature, got ${secondSignature.length}`)
  }
  // Byte-equal comparison — both buffers are r(32)||s(32)||v(1) in canonical form, so identical
  // signatures over identical messages must match byte-for-byte. Constant-time comparison isn't
  // needed: these are public signatures of a public message, not key material; the comparison
  // outcome is itself disclosed to the UI immediately.
  let deterministic = true
  for (let i = 0; i < 65; i++) {
    if (firstSignature[i] !== secondSignature[i]) {
      deterministic = false
      break
    }
  }
  // SECURITY (V2 §"Signature discipline"): zero our local copy of the second signature now
  // that the comparison is done. The first signature is NOT zeroed here — the caller is the
  // owner and will hand it on to `enrollFromSignature`, which zeros it after HKDF. Zeroing
  // it here would be a use-after-free for the next caller. Best-effort, same caveat as
  // elsewhere: JS gives no guarantees but the discipline closes the window meaningfully.
  secondSignature.fill(0)
  return { deterministic }
}

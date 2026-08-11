// ABOUTME: Shield primitives — the ephemeral shieldPrivateKey generator + the ShieldRequestData shape.
// ABOUTME: The note itself is built by shield-sdk.ts (createShieldRequestSdk) via @armada/sdk; the contract call lives in features/shield/handler.ts.

/**
 * Generate a fresh ephemeral `shieldPrivateKey` per deposit — 32 random bytes as 64-char lowercase
 * hex (no `0x` prefix; the SDK consumes it that way).
 *
 * Why random instead of `personal_sign('RAILGUN_SHIELD')`-derived (Railgun's convention):
 * - `shieldPrivateKey` is a per-deposit ECIES *sender* secret. The recipient's chain scan
 *   decrypts via their viewing key + the on-chain `shieldKey` (which is the public viewing key
 *   of `shieldPrivateKey`). The sender's key is never re-needed after the shield is built —
 *   randomness is correct.
 * - Railgun's deterministic convention enables "sender-side history recovery from EVM wallet
 *   alone" across shielded wallets. We don't use that recovery path (our identity layer is
 *   `root_secret`-derived with a non-deterministic enrollment, so EVM-only recovery isn't
 *   available regardless), so the convention has no value for our app.
 * - Eliminates one wallet prompt per deposit; the engine's own `relay-adapt-helper` already
 *   uses `randomHex(32)` for its internal shields, proving correctness end-to-end.
 *
 * Uses `crypto.getRandomValues` (Web Crypto) — same source the SDK's `ByteUtils.randomHex` uses
 * for its random salt input on the same code path.
 */
export function generateRandomShieldPrivateKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Output shape ready to feed into PrivacyPool.shield()'s ShieldRequest tuple.
 *
 *   preimage   = { npk, token: { tokenType, tokenAddress, tokenSubID }, value }
 *   ciphertext = { encryptedBundle: bytes32[3], shieldKey: bytes32 }
 *
 * We hand back the inner fields separately so the handler can compose the tuple verbatim
 * (matching the on-chain `ShieldRequest` ABI without re-introducing engine types at the call
 * site). All bytes32 fields are 0x-prefixed.
 */
export interface ShieldRequestData {
  readonly npk: `0x${string}`
  readonly value: bigint
  readonly encryptedBundle: readonly [`0x${string}`, `0x${string}`, `0x${string}`]
  readonly shieldKey: `0x${string}`
  /**
   * The 16-byte per-note salt (hex, no 0x) the engine bound into `npk = Poseidon(masterPublicKey,
   * random)`. Surfaced so a relayer fee note can be verified without decryption: the relayer
   * recomputes the npk from its own masterPublicKey + this random and matches it against the note
   * (same primitive as the yield-redeem `feeShieldRandom`, see relayer `redeem-fee-verifier.ts`).
   */
  readonly random: string
}


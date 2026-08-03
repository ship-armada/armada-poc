// ABOUTME: Shield request builder — generates an ephemeral shieldPrivateKey + constructs ShieldNoteERC20 via the Railgun engine (Poseidon NPK + ECIES bundle).
// ABOUTME: Pure SDK-side logic; the contract call lives in features/shield/handler.ts. Dynamic imports avoid jsdom's circomlibjs crash.

// `@railgun-community/engine` ships circomlibjs at module-load and crashes under jsdom; defer.
type RailgunEngine = typeof import('@railgun-community/engine')
async function railgunEngine(): Promise<RailgunEngine> {
  return import('@railgun-community/engine')
}

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
 *   alone" across Railgun wallets. We don't use that recovery path (our identity layer is
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

function toBytes32Hex(input: string | bigint): `0x${string}` {
  const hex = typeof input === 'bigint'
    ? input.toString(16)
    : input.startsWith('0x') ? input.slice(2) : input
  if (hex.length > 64) throw new Error(`toBytes32Hex: value too long (${hex.length} hex chars)`)
  return `0x${hex.padStart(64, '0')}` as `0x${string}`
}

/**
 * Build a single ShieldRequest for the given recipient + amount on the hub chain.
 *
 * The engine's `ShieldNoteERC20` owns the cryptographic machinery (Poseidon NPK over the random,
 * ECIES-encrypted bundle of the random + viewing keys). We just feed inputs and re-format the
 * outputs to bytes32-hex.
 *
 * NOTE: only the hub-side direct shield is supported today. Cross-chain shield (PrivacyPoolClient
 * → CCTP → hub) will get its own variant in a later commit; the engine call is the same but the
 * contract surface differs.
 */
export async function createShieldRequest(
  railgunAddress: string,
  amount: bigint,
  tokenAddress: string,
  shieldPrivateKeyHex: string,
): Promise<ShieldRequestData> {
  if (!railgunAddress.startsWith('0zk')) {
    throw new Error('createShieldRequest: railgunAddress must start with 0zk')
  }
  if (amount <= 0n) {
    throw new Error('createShieldRequest: amount must be positive')
  }
  if (!/^[0-9a-fA-F]{64}$/.test(shieldPrivateKeyHex)) {
    throw new Error('createShieldRequest: shieldPrivateKey must be 64 hex chars (no 0x)')
  }

  const { RailgunEngine, ShieldNoteERC20, ByteUtils } = await railgunEngine()
  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(railgunAddress)

  // 16 random bytes — the per-note salt the engine binds into NPK + ciphertext.
  const random = ByteUtils.randomHex(16)
  const shieldNote = new ShieldNoteERC20(masterPublicKey, random, amount, tokenAddress)

  const shieldRequest = await shieldNote.serialize(
    ByteUtils.hexToBytes(shieldPrivateKeyHex),
    viewingPublicKey,
  )

  // The engine returns these as BigNumberish-ish strings; normalize to bytes32 hex.
  return {
    npk: toBytes32Hex(shieldRequest.preimage.npk.toString()),
    value: BigInt(shieldRequest.preimage.value.toString()),
    encryptedBundle: [
      toBytes32Hex(shieldRequest.ciphertext.encryptedBundle[0].toString()),
      toBytes32Hex(shieldRequest.ciphertext.encryptedBundle[1].toString()),
      toBytes32Hex(shieldRequest.ciphertext.encryptedBundle[2].toString()),
    ] as const,
    shieldKey: toBytes32Hex(shieldRequest.ciphertext.shieldKey.toString()),
    random,
  }
}

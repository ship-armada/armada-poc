# lib/crypto/

Pure-logic crypto primitives for the signature-derived key system. No React, no SDK, no DOM dependencies beyond `globalThis.crypto.getRandomValues`. Spec: `specs/TX_SIGNING.md` + `specs/TX_SIGNING_V2_AMENDMENT.md` (v2 governance fork — `issuedAt` removed, deterministic by design, re-signing promoted to primary recovery path, `account: uint256` added).

## Contents

| File | Purpose |
|---|---|
| `eip712.ts` | Enrollment typed-data builder + signature normalization (65-byte r‖s‖v, EIP-2098 compact expansion, v∈{0,1}→{27,28}). |
| `kdf.ts` | HKDF-SHA-256 derivation (root + spend/view subkeys), anti-phish checksum, AES-256-GCM backup encryption with PBKDF2-SHA-256@600k, `bytesToBigIntBE`, IC-2 entropy floor canary. |
| `boundary-vectors.test.ts` | The 6 bytes-to-scalar boundary vectors from spec §"Bytes to Field Element Mapping" (Vector 1 zero, r exactly, r−1, r+1, 0xFF…FF, 2r+42). |

## Hard rules

- **No `console.log` / `console.debug` of derived secrets.** This includes `root_secret`, spending/viewing key bytes, the SDK encryption key, the user passphrase, and anything derived from them. Secret-leak prevention. (Same rule as `lib/shielded/` from the root CLAUDE.md.)
- **IC-1: No JavaScript `Number` in derivation paths.** All byte-to-scalar conversions use `bigint`. The boundary vector test catches accidental float truncation. Avoid `parseInt` on key material; use `bytesToBigIntBE` or the byte-array forms directly.
- **IC-3: Opaque byte passthrough.** Raw signature bytes are passed to HKDF as a `Uint8Array`. Do not parse (r, s, v) components through numeric intermediates before HKDF input — `eip712.ts::normalizeSignature` returns the canonical 65 bytes ready for HKDF.
- **Identity-determining constants are frozen.** `eip712.ts` exports `VERIFYING_CONTRACT`, `DOMAIN_NAME`, `MESSAGE_PURPOSE`, `MESSAGE_VERSION`. Changing any of these — even formatting — forks every user's shielded identity. The four together are a governance-frozen tuple per the spec.
- **No HMAC, no symmetric ciphers other than what's listed above.** Phase 1 is fixed at HKDF-SHA-256 + AES-256-GCM + PBKDF2-SHA-256@600k. Phase 2 adds Argon2id as the preferred KDF (parsers already validate `kdf: 'argon2id' | 'scrypt' | 'pbkdf2-sha256'` per the spec's interop contract).

## Identity derivation (`root_secret` → shielded keys)

Identity comes from `@armada/sdk`'s `deriveKeyset(root_secret)` — it consumes the 32-byte `root_secret` directly and returns the shielded (0zk) address + keyset. There is no mnemonic in the path: the earlier engine-era `deriveInternalMnemonic` → `createRailgunWallet` shim has been removed. The interface's own `deriveSpendingKeyBytes` / `deriveViewingKeyBytes` (HKDF-Expand) survive **only** as inputs to the IC-2 entropy-floor canary (`assertEntropyFloor` in `lib/shielded/wallet.ts`) — they are NOT the keys the SDK spends with.

**Key-material stability:** identity is a pure function of `root_secret` (→ `deriveKeyset`), so a given `root_secret` always reproduces the same 0zk address. A future protocol change (custom circuits — see `ARCHITECTURE_NOTES.md`) could redefine the derivation; those keys would not be interoperable with today's. Accepted: testnet identity is disposable, mainnet starts fresh.

## What this folder will gain in Phase 2

- `reduce(bytes, modulus)` against Andrew's confirmed modulus (`r` vs `l` for spending, `l_ed` vs `r` for viewing)
- Zero-scalar handling (either accept-if-safe or re-derive with `:v1:1`)
- IC-4 end-to-end test vectors with real signatures
- Optional Argon2id backup encryption (preferred KDF when available)
- Web Worker entry points for spending-key derivation

Until Andrew's confirmations land, those stay TODO. The Phase 1 surface is forward-compatible — adding reduction is additive, not breaking.

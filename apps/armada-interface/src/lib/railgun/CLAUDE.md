# lib/railgun/

Wrappers around `@railgun-community/wallet` / `@railgun-community/engine` for shielded wallet lifecycle, proof generation, and tree sync.

## Files

| File | Purpose | Status |
|---|---|---|
| `wallet.ts` | V2 signature-derived signIn + unlock-by-paste + unlock-by-backup + lock + reset. Per-(EVM address, account) localStorage map (`armada.shielded.walletIds` / `armada.shielded.checksums`) drives the cached fast-path. Records the unlock binding on `keyManager` for Phase 4 account-switch detection. | Working |
| `schema-migration.ts` | V2 schema-version bootstrap migration. On cold boot, if `armada.shielded.schemaVersion < 2`, wipes legacy localStorage keys + drops the `armada-shielded` + `armada-interface` IndexedDB DBs. Idempotent. | Working |
| `keyManager.ts` | Module-scope unlocked-state singleton — owns the live `rootSecret`, walletId, `sdkEncryptionKey`, `historyEncryptionKey` (Phase 7), railgun address, checksum, evmAddress + account binding. Zeroizes the `rootSecret` + `historyEncryptionKey` buffers on `clear()`. | Working |
| `init.ts` | `startRailgunEngine` + POI dummy + level-js DB + IndexedDB artifact store. Idempotent. | Working |
| `network.ts` | Patches the SDK's `NETWORK_CONFIG.Hardhat` entry to point at our PrivacyPool deployment; loads the hub provider via `loadProvider`. | Working |
| `database.ts` | `createWebDatabase` — IndexedDB-backed LevelDB instance the engine uses for persistence. | Working |
| `artifacts.ts` | IndexedDB-backed ArtifactStore that caches ZK circuit artifacts across reloads. | Working |
| `prover.ts` | Lazy-initialise the proving engine; expose proof generation entry points. | Stub |
| `sync.ts` | Subscribe + multiplex SDK balance-update events; `refreshShieldedBalances` + `getShieldedERC20Balance` helpers. Bridge hook lives in `hooks/useShieldedBalanceSync.ts`. | Working |
| `history.ts` | V1 Phase 9 — wraps the SDK's `getWalletTransactionHistory` and maps `TransactionHistoryItem` → `TxRecord` for chain-driven recovery. Exports `runHistoryScan` (high-level), `historyItemToTxRecord` (pure mapper), `syntheticTxId` (deterministic id encoding). Yield ops detected via the configured adapter address. | Working |
| `history-checkpoint.ts` | Per-wallet localStorage checkpoint (`armada.shielded.historyScanBlock.<walletId>`) so incremental scans only walk the delta since the last `block`. Wiped on Settings → Reset wallet and Settings → Re-scan history. | Working |

## Secret-handling rules (HARD)

Privacy apps routinely leak through carelessly-written telemetry and dev logs. Belt-and-suspenders rules for everything in this directory:

1. **Never `console.log` / `console.debug` mnemonics, viewing keys, spending keys, decrypted DEKs, or anything derived from them.** Use `lib/telemetry.ts::track` for structured events with allowlisted shapes — the registry won't let a key slip through.

2. **Memory zeroization** (reviewer rec #11):
   - Where the Railgun SDK gives us key material as `Uint8Array`, `fill(0)` after use.
   - Avoid storing the mnemonic as a JS string when avoidable — strings are interned and cannot be zeroized. Prefer `Uint8Array` of UTF-8 bytes; convert at the SDK boundary only.
   - Decrypted DEK lives in memory for one operation, then `fill(0)`. Never store on `window`, in localStorage, or in a Jotai atom.
   - JS makes zeroization imperfect (V8 may move buffers), but the discipline still meaningfully reduces leak surface.

3. **Encryption at rest.** Be precise about what the SDK encrypts vs. what it doesn't (verified against `@railgun-community/engine` 9.5.1):
   - **SDK wallet blob — encrypted.** Only the mnemonic / wallet record is written via `putEncrypted(sdkEncryptionKey)` (`sdkEncryptionKey` = HKDF-Expand from `rootSecret`) in `armada-shielded` IDB. Salt + IV handled by the SDK.
   - **Decrypted note plaintext — NOT encrypted.** The engine writes decrypted receive commitments — `TransactNote.serialize()` plaintext (value, recipient/sender 0zk address, memo) — with a plain `db.put` under the `wallet:<id>:<chain>` namespace (`wallet/abstract-wallet.js`). This is decrypted-at-rest while the wallet exists in IDB. **Mitigation (WS7.2 Option A):** `lockWallet` calls `walletForID(id).clearDecryptedBalancesAllTXIDVersions(chain)` on every lock, so the plaintext does not persist while the wallet is locked; the next unlock re-decrypts locally from the public merkletree (no network rescan). This does NOT cover abrupt termination (a tab kill skips the lock path). Full at-rest encryption of the `wallet:` namespace is the deferred Option B (an encrypting leveldown wrapper) — see plan WS7.2.
   - **Tx history (V2 Phase 7) — encrypted.** Every `TxRecord` persisted by `lib/tx/storage.ts` is wrapped via `lib/crypto/cache-cipher.ts` as AES-256-GCM (`{ nonce: hex, ciphertext: hex }`) under `historyEncryptionKey` (HKDF-Expand from `rootSecret`, info=`'armada-tx-history:v1'`). Foreign-wallet records throw on `unwrap` and get silently skipped at hydration. The envelope deliberately carries no plaintext walletId — isolation is purely key-based.

4. **Session-bound unlock.** Decrypted key material is held in memory for the active session only. **15-minute inactivity timeout** auto-locks (zeroizes). Lock also fires on tab unload (`beforeunload`), after a **5-minute tab-hidden grace period** (`visibilitychange`), and on EVM-account switch (V2 Phase 4 — `useWallet` compares wagmi's address against `keyManager.getEvmAddress()` and locks on mismatch). Reload requires re-signing.

5. **No raw secret in URL, in clipboard for longer than necessary, or in error messages.** Export UX (Settings → Export recovery) shows the recovery secret in a confirm-gated modal and clears it on close. The EIP-712 signature itself is also subject to discipline (V2 Phase 2b): no transmission, no persistence, no logging, zeroize after HKDF derivation. The future ESLint rule for mechanical enforcement is deferred to v2 (see `specs/TX_SIGNING_V2_AMENDMENT.md`).

## Warmup state

`prover.ts::initProver()` updates `railgunEngineAtom` through `'cold' → 'warming' → 'ready'` (or `'failed'`). Callers can observe state via the atom; the UI shows a "warming up…" indicator during first use.

`initProver()` is idempotent — calling twice while warming or after ready is a no-op. Engine init is heavy (WASM artifacts ~1MB+); the executor's first stage handler that needs proofs should await readiness before proceeding.

## Spec compliance gaps tracked for v2

See `specs/TX_SIGNING_V2_AMENDMENT.md` §"Outstanding compliance gaps from this redesign":

- **Web Worker isolation for spending key operations** — spec mandates that proof signing + key-decrypt operations run in a dedicated Web Worker. Deferred because the Railgun SDK isn't architected for parallel instances against the same `armada-shielded` IDB; v2 follow-up needs either an upstream SDK refactor or a non-trivial parallel-SDK-in-worker setup.
- **ESLint rule for signature discipline** — `no-restricted-syntax` to mechanically catch `fetch(sig)` / `console.log(sig)` / etc. Deferred because the app has no eslint config yet.

## WebAuthn (future, not now)

V2 redesign accepted "deterministic re-sign from EVM wallet" as the primary recovery path. WebAuthn-wrapped key storage is the right v2 hardening (origin-bound, addresses the malicious-extension threat the current in-memory model doesn't fully cover). Future work; see plan §7 non-goals.

## `creationBlock` invariant: always anchor at hub deploy block

A deterministic-re-sign wallet identity is purely a function of the EOA signature — there is no local bit that distinguishes "first ever creation" from "re-creation after the user cleared local storage on a wallet that already has chain activity." Both produce the same root_secret → same SDK walletId.

Consequence: if first-time enrollment seeded the SDK's `creationBlockNumbers` at the *current* head (the obvious "fast path" choice), then a user who cleared local storage and re-signed would have their prior shields, transacts, unshields, and yield deposits silently amputated from `getWalletTransactionHistory` AND from balance — the SDK's merkletree scan starts at `creationBlockNumbers` and never walks back.

**The fix:** `resolveCreationBlock()` always picks `hub.deployBlock` (falling back to current head only when older manifests omit it). Trade-off: every first-sign-in on a device pays the full chain scan cost (~10–30s on Sepolia, longer on mainnet at scale). Trade-off accepted because the alternatives have worse properties:

- **On-chain registry** (`EOA → first commitment block`) re-links the EOA to "has a shielded wallet," undoing the privacy property the EIP-712 sign just paid for.
- **Relayer-side registry** requires sharing the walletId with our infra, enabling cross-session correlation.
- **Optimistic + lazy backfill** (sign in fast, deep-scan in the background) is appealing but the SDK doesn't currently expose a clean API to extend `creationBlockNumbers` backwards on an existing wallet — would require deleting + recreating, which has its own footguns.
- **Asking the user** ("have you used this wallet before?") trades a slow scan for a silent-data-loss footgun if they answer wrong.

If a future SDK release ships a `walletForID(id).extendSyncRange(fromBlock)`-style API, switching to lazy backfill becomes viable — until then, anchoring at deploy block is correct.

## What we explicitly DON'T do

- Custodial fallback. No server-side key escrow, ever.
- Mnemonic upload / cloud sync. The user owns their recovery material.
- Direct interop with MetaMask / EVM wallet seed phrases. Railgun mnemonic is independent of the EVM wallet (reviewer rec #5).
- Cross-device sync of the encrypted blob. The v2 model makes cross-device unlock work via re-sign, paste-secret, or backup-file restore — no sync-the-blob mechanism is needed or built.

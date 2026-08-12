# lib/shielded/

Shielded-wallet lifecycle, proof generation, and tree sync — built entirely on `@armada/sdk`. (The
stock `@railgun-community/*` engine has been fully removed; the `railgun/` directory name is retained
as an internal identifier only — see the naming rule below.)

## Files

| File | Purpose | Status |
|---|---|---|
| `wallet.ts` | V2 signature-derived signIn + unlock-by-paste + unlock-by-backup + lock + reset. Per-(EVM address, account) localStorage map (`armada.shielded.walletIds` / `armada.shielded.checksums`) drives the cached fast-path. Records the unlock binding on `keyManager` for Phase 4 account-switch detection. | Working |
| `schema-migration.ts` | V2 schema-version bootstrap migration. On cold boot, if `armada.shielded.schemaVersion < 2`, wipes legacy localStorage keys + drops the `armada-shielded` + `armada-interface` IndexedDB DBs. Idempotent. | Working |
| `keyManager.ts` | Module-scope unlocked-state singleton — owns the live `rootSecret`, walletId, `sdkEncryptionKey`, `historyEncryptionKey` (Phase 7), shielded (0zk) address, checksum, evmAddress + account binding. Zeroizes the `rootSecret` + `historyEncryptionKey` buffers on `clear()`. | Working |
| `artifactGetter.ts` | In-memory ZK-circuit artifact registry keyed by padded circuit shape (`NNxMM`). `preloadArtifactsFromOrigin` (artifacts.ts) populates it; the `@armada/sdk` ArtifactSource (`sdk-prover.ts`) resolves circuits from it. Owns the local `ArmadaArtifact` type. | Working |
| `nullifierCrossCheck.ts` | WI-5 safety net: after a scan, queries the hub PrivacyPool's `nullifiers(...)` for the wallet's own unspent notes (`wallet.spendableNullifiers()`), batched into one Multicall3 `aggregate3` eth_call (`lib/multicall3.ts`). Catches a watcher that omits a `Nullified` event (which merkleroot validation can't see). Fails open on RPC error. Bridge hook: `hooks/useNullifierCrossCheck.ts`; gate: `hooks/useSpendableSyncGate.ts`. | Working |
| `network.ts` | Pure-ethers hub-chain RPC helpers: `timeoutProvider` (timeout-bounded JsonRpcProvider, reused by the nullifier cross-check + history backfill), `getCurrentHubBlock` (creation-block seed), `getHubBlockTimestamps` (history timestamp backfill). No engine coupling. | Working |
| `artifacts.ts` | Preloads the demo-critical ZK circuit artifacts (zkey/wasm/vkey) from the app's own origin (`/artifacts/...`) into the `artifactGetter` registry, so the first proof doesn't fetch from IPFS. | Working |
| `balance-bus.ts` | SDK-native leaf module (imports nothing) with two channels: a balance-change bus (fans the `@armada/sdk` wallet's `scan:complete` / `balance:updated` / `note:received` events out as "something changed" pings) and a scan-status bus (`emitScanStatus` / `subscribeScanStatus` — carries scan lifecycle + progress fraction that drives `syncStateAtom`). `sdk-read.ts` installs the `wallet.on(...)` forwarders; consumers subscribe via `sync.ts`. | Working |
| `sync.ts` | Thin facade: re-exports the balance bus (`subscribeBalanceUpdates` / `subscribeScanStatus` / `resetSyncState`) + `refreshShieldedBalances` (from `sdk-read.ts`) so consumers keep one import surface. `hooks/useShieldedBalanceSync.ts` reads on each ping + drives `syncStateAtom` off scan status; `hooks/useShieldedSyncPoll.ts` drives the periodic `wallet.sync()`. | Working |
| `sdk-read.ts` | The `@armada/sdk` shielded read path — a persistent IndexedDB-backed SDK instance (`ensureInstance`/`closeSdkRead`). Sole source of all shielded balance + history reads. **Sync vs read are split**: `refreshShieldedBalances` is the ONLY syncer (`wallet.sync()`, driven by the 15s poll + post-tx refresh + initial unlock); `readSdkUsdcBalance` / `readSdkYieldShares` / `readSdkHistory` read the current scan state WITHOUT syncing (called from balance-bus event handlers, which fire because a sync just completed — re-syncing there is circular). | Working |
| `sdk-telemetry.ts` | Leaf module — the `TelemetrySink` handed to `createArmadaSdk`. Maps the SDK's `sync.quicksync` event → `track('sdk.quicksync')` so an operator can confirm a configured indexer (watcher) is actually serving a root-verified batch (`served`, `tailCovered` on tail-lag) vs being rejected (`root-mismatch-fallback`). Emits nothing on RPC-only syncs. | Working |
| `history.ts` | Chain-driven history recovery — `runHistoryScan` syncs the `@armada/sdk` wallet, maps each `HistoryEntry` → `TxRecord` (`historyEntryToTxRecord`, pure), backfills block timestamps, and returns a checkpoint candidate. `syntheticTxId` encodes deterministic ids. Yield ops classified natively by the SDK. | Working |
| `history-checkpoint.ts` | Per-wallet localStorage checkpoint (`armada.shielded.historyScanBlock.<walletId>`) so incremental scans only walk the delta since the last `block`. Wiped on Settings → Reset wallet and Settings → Re-scan history. | Working |

## Secret-handling rules (HARD)

Privacy apps routinely leak through carelessly-written telemetry and dev logs. Belt-and-suspenders rules for everything in this directory:

1. **Never `console.log` / `console.debug` mnemonics, viewing keys, spending keys, decrypted DEKs, or anything derived from them.** Use `lib/telemetry.ts::track` for structured events with allowlisted shapes — the registry won't let a key slip through.

2. **Memory zeroization** (reviewer rec #11):
   - Where the SDK gives us key material as `Uint8Array`, `fill(0)` after use.
   - Avoid storing the mnemonic as a JS string when avoidable — strings are interned and cannot be zeroized. Prefer `Uint8Array` of UTF-8 bytes; convert at the SDK boundary only.
   - Decrypted DEK lives in memory for one operation, then `fill(0)`. Never store on `window`, in localStorage, or in a Jotai atom.
   - JS makes zeroization imperfect (V8 may move buffers), but the discipline still meaningfully reduces leak surface.

3. **Encryption at rest.** Be precise about what the SDK encrypts vs. what it doesn't (verified against `@railgun-community/engine` 9.5.1):
   - **Shielded reads run through the `@armada/sdk` read instance** (`sdk-read.ts`), which persists its
     scan state in a per-deployment IndexedDB database (`armada-shielded-scan-e2-<chainId>-<pool>`),
     separate from the historical stock-engine `armada-shielded` DB.
   - **Decrypted note plaintext — encrypted at rest, SDK-owned (§4.3) ✅.** The interface passes the SDK a
     **raw** `IndexedDBStorageAdapter`; the SDK auto-wraps it **per wallet** in an `EncryptedStore` keyed from
     the **viewing private key** (AES-256-GCM, record-key bound as AAD), held only in memory. The DB holds
     only ciphertext at rest — a tab crash / disk read leaks no decrypted note data (value, recipient/sender
     0zk, memo). Locking tears the instance down (`closeSdkRead`) → the SDK's key is dropped; Settings → Reset
     deletes the DB. Prior-schema DBs (pre-encryption plaintext + the interface's earlier `-e1` rootSecret-keyed
     wrap) are best-effort deleted on the next unlock so nothing stale lingers. We never set the SDK's
     `dangerouslyAllowPlaintextStorage` escape hatch. **Do NOT re-wrap the adapter in `EncryptedStore` here —
     the SDK owns this; wrapping would double-encrypt under a mismatched key.**
   - **Tx history (V2 Phase 7) — encrypted.** Every `TxRecord` persisted by `lib/tx/storage.ts` is wrapped via `lib/crypto/cache-cipher.ts` as AES-256-GCM (`{ nonce: hex, ciphertext: hex }`) under `historyEncryptionKey` (HKDF-Expand from `rootSecret`, info=`'armada-tx-history:v1'`). Foreign-wallet records throw on `unwrap` and get silently skipped at hydration. The envelope deliberately carries no plaintext walletId — isolation is purely key-based.

4. **Session-bound unlock.** Decrypted key material is held in memory for the active session only. **15-minute inactivity timeout** auto-locks (zeroizes). Lock also fires on tab unload (`beforeunload`), after a **5-minute tab-hidden grace period** (`visibilitychange`), and on EVM-account switch (V2 Phase 4 — `useWallet` compares wagmi's address against `keyManager.getEvmAddress()` and locks on mismatch). Reload requires re-signing.

5. **No raw secret in URL, in clipboard for longer than necessary, or in error messages.** Export UX (Settings → Export recovery) shows the recovery secret in a confirm-gated modal and clears it on close. The EIP-712 signature itself is also subject to discipline (V2 Phase 2b): no transmission, no persistence, no logging, zeroize after HKDF derivation. The future ESLint rule for mechanical enforcement is deferred to v2 (see `specs/TX_SIGNING_V2_AMENDMENT.md`).

## Proving warmup

Proving runs on an off-main-thread Web Worker created lazily by `sdk-prover.ts::createInterfaceProver`
— the worker (snarkjs + `@armada/sdk/prover`) is spawned on the FIRST `prove()` call, so read-only
sessions never pay for it, and it is terminated on `close()`. There is no separate engine-init step and
no atom-observable warmup state anymore (the old `railgunEngineAtom` / `prover.ts::initProver` were removed
with the stock engine). The circuit artifacts the worker needs are preloaded into the `artifactGetter`
registry on app mount by `artifacts.ts::preloadArtifactsFromOrigin`.

## Spec compliance gaps tracked for v2

See `specs/TX_SIGNING_V2_AMENDMENT.md` §"Outstanding compliance gaps from this redesign":

- **Web Worker isolation for spending key operations** — spec mandates that proof signing + key-decrypt operations run in a dedicated Web Worker. Deferred because the SDK isn't architected for parallel instances against the same `armada-shielded` IDB; v2 follow-up needs either an upstream SDK refactor or a non-trivial parallel-SDK-in-worker setup.
- **ESLint rule for signature discipline** — `no-restricted-syntax` to mechanically catch `fetch(sig)` / `console.log(sig)` / etc. Deferred because the app has no eslint config yet.

## WebAuthn (future, not now)

V2 redesign accepted "deterministic re-sign from EVM wallet" as the primary recovery path. WebAuthn-wrapped key storage is the right v2 hardening (origin-bound, addresses the malicious-extension threat the current in-memory model doesn't fully cover). Future work; see plan §7 non-goals.

## `creationBlock` invariant: always anchor at hub deploy block

A deterministic-re-sign wallet identity is purely a function of the EOA signature — there is no local bit that distinguishes "first ever creation" from "re-creation after the user cleared local storage on a wallet that already has chain activity." Both produce the same root_secret → same SDK walletId.

Consequence: if first-time enrollment seeded the SDK's `creationBlockNumbers` at the *current* head (the obvious "fast path" choice), then a user who cleared local storage and re-signed would have their prior shields, transacts, unshields, and yield deposits silently amputated from the `@armada/sdk` wallet history AND from balance — the merkletree scan starts at `creationBlockNumbers` and never walks back.

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

# Interface → @armada/sdk Migration Plan

Status: **interface migration complete** (2026-08). The interface runs entirely on `@armada/sdk`; the
stock `@railgun-community/*` engine is gone from the interface (no imports in `apps/armada-interface/src`).
Gate 0, Phase A, Phase B, and most of Phase C are done and merged; the tail items (at-rest encryption,
tree-wide Railgun removal, native value-types, the `railgunAddress` rename) are tracked under
**Remaining** below. Read alongside `.claude/PLAN_ARMADA_INTERFACE.md` (the interface's own architecture doc).

## Guiding principle (locked)

The SDK, relayer, and interface are all **pre-production**. Optimize for long-term-clean solutions; make whatever changes are needed to get there. **Never lock into a Railgun-inherited shape for short-term compatibility ease.** End goal: remove `@railgun-community/*` as a dependency **entirely**. The SDK is meant to be consumed by future apps, so its public API must be **SDK-owned**, not a Railgun passthrough.

**No dual-format / dual-SDK maintenance.** Do not run the Railgun shape and the SDK shape in parallel to smooth a transition — migrate **totally** and cut over. This governs both the watcher's quick-sync (native shape only; the engine-format endpoint is deleted, not kept alive next to it) and the interface (SDK-native only). Coordinate cutovers so nothing keeps the Railgun shape breathing.

The interface is **alpha** — re-platform onto the SDK's native model; do NOT build engine-compat shims.

## Native-not-ported rules (HARD)

When migrating an interface capability onto the SDK, build the **native** equivalent. Do not port the Railgun convenience just because the interface uses it today:

1. **Tx history** — design a native read API off the SDK's own scan state (TXOs / decrypted notes / spent nullifiers). Do NOT mirror `getWalletTransactionHistory` or the `TransactionHistoryItem*` types.
2. **Gas** — drop the `EVMGasType.Type1/Type2` + `overallBatchMinGasPrice` ceremony. That's a Railgun `populate*` artifact; native calldata construction (`buildTransactCalldata`) needs only `boundParams.minGasPrice` for relayer-submitted txs. This is a **deletion**, not a reimplementation.
3. **Wrappers / adapt** — expose the proved struct natively (`ProofHandle.toTransactionData()`) and hand-encode the Armada wrapper calldata (`atomicCrossChainUnshield` / `lendAndShield` / `redeemAndShield`) from it. Do NOT reintroduce Railgun `generateProofTransactions` / `relayAdaptID` / RelayAdapt. We already model `adaptContract` / `adaptParams` natively.
4. **Sync / events** — SDK-native `EventSource` (getLogs default + native `/v2/quick-sync` indexer) + typed `SyncEventMap`. Do NOT preserve the engine's global balance callback, quicksync-callback, or LevelDB model.
5. **Identity / storage** — `fromRootSecret` + a StorageAdapter, and own the at-rest encryption (encrypt the whole namespace — the deferred "Option B"). Do NOT depend on the engine's `putEncrypted` / `clearDecryptedBalancesAllTXIDVersions` semantics.

## Sequencing (all done unless noted)

- **Gate 0 — SDK additions (native, unblock the migration):** ✅ done + consumed
  - Quicksync `EventSource` + native `/v2/quick-sync` wire contract — ✅ `RpcEventSource` + `IndexerEventSource` + on-chain root-verify + RPC fallback (armada-sdk). Consumed by `sdk-read.ts` (indexer optional via `VITE_INDEXER_URL`).
  - Native tx-history read API — ✅ `wallet.history()` / `reconstructHistory`; interface `readSdkHistory` + `runHistoryScan`.
  - `ProofHandle.toTransactionData()` accessor — ✅ used by the xchain/yield wrapper encoders.
  - Broadcaster-fee output on `planTransfer`/`prove` (the `FeeRequest` path) — ✅.
- **Phase A — read path:** ✅ `createArmadaSdk` instance + IndexedDB `StorageAdapter` + identity parity (`deriveKeyset`) + sync/balances via `SyncEventMap`. Shadow-differential → cutover done. (Sync-vs-read split later hardened to kill an amplification loop — see `sdk-read.ts`.)
- **Phase B — write path:** ✅ shield → transfer → unshield-local → xchain-unshield → yield, all migrated + engine builders deleted; off-thread worker prover.
- **Phase C — history + nullifier cross-check + at-rest encryption:** ⚠️ **partial** — history ✅, nullifier cross-check ✅ (`spendableNullifiers()`), **at-rest encryption still deferred** (see Remaining).

## Railgun-removal end-state milestone

An explicit completion gate — the flags below are **transitional scaffolds**, not a permanent dual-backend:

- Delete all stock / `SDK_BACKEND=stock` paths (v1 relayer + `lib/sdk` seam); relayer v2 armada-only (armada-relayer#26); interface armada-only.
  - ✅ **interface armada-only** (teardown, PoC #463 — engine init/prover/quicksync/database deleted, `@railgun-community/*` dropped from `apps/armada-interface/package.json`).
  - ❌ **tree-wide** — the POC's contract/relayer/deploy tooling (root `package.json`, `relayer/modules`, `lib/sdk`, `scripts/capture`) still runs on stock Railgun. Being removed **gradually** over future work; relayer v2 is a separate repo (armada-relayer#26, deferred).
- **Zero `@railgun-community/*` dependencies** anywhere in the tree — ❌ not yet (interface: yes; rest of the tree: gradual, per above).
- **Own the SDK's public value-types natively** — `TokenData`, `Chain`, `AddressData`, `Ciphertext`, and the `ChainType` / `TokenType` / `TXIDVersion` enums — replacing the vendored re-exports in `src/core/index.ts`. Natural point: **when the vendored engine is dropped for custom circuits** (these get redefined then anyway). Until then, the vendored re-exports are the SDK's documented owned contract — low lock-in risk (protocol-dictated shapes; no behavioral Railgun classes are public). Redefining earlier is churn: numeric-enum boundary friction for little near-term benefit.

## Capability map (from the read/write inventory)

| Interface capability | SDK status |
|---|---|
| Identity (rootSecret → 0zk) | ✅ `deriveKeyset` — parity verified |
| Shield (random shieldPrivateKey) | ✅ `buildShieldRequest` |
| Gasless / xchain shield | ✅ `buildGaslessShield` (+ cross-chain variant) |
| Transfer / unshield-local | ✅ `planTransfer`→`prove`→`buildTransactCalldata` |
| adaptParams (cctp / yield) | ✅ `encodeCctpBinding` + yield binding encoders |
| Proving / artifacts | ✅ `ProverAdapter` + `ArtifactSource` (off-thread worker prover) |
| Balances / sync | ✅ native scan engine + `/v2` quicksync EventSource; `sdk.quicksync` observability |
| Tx history | ✅ native `wallet.history()` — not ported from Railgun |
| Proved struct for wrappers | ✅ `ProofHandle.toTransactionData()` |
| Gas Type1/Type2 ceremony | 🗑️ deleted — `populate*` artifact, not needed natively |
| At-rest encryption | ⚠️ **deferred** — StorageAdapter-level encryption (Option B); still plaintext-at-rest, at parity with the stock engine |

## Remaining (tail items — migration itself is done)

1. **At-rest encryption of the SDK read instance** (Phase C tail, "Option B"). The read instance's IndexedDB (`armada-sdk-shadow` — legacy name from the Phase-A shadow-differential) holds decrypted note plaintext unencrypted while unlocked, and unlike the stock engine we do **not** clear it on lock (`closeSdkRead` releases the instance but leaves the DB; only Reset deletes it). This is at parity with stock Railgun for the *encrypted wallet blob* (both encrypt the mnemonic) and *matches* Railgun's unencrypted decrypted-notes-at-rest — a lock-time clear is the one thing the engine did that we don't. Needs an encrypting `StorageAdapter` wrapper (and/or a cheap lock-time clear if the SDK exposes re-decrypt-from-tree). Deferred: PoC/testnet, no real funds, tracked.
2. **Tree-wide Railgun removal** — gradual over future work (contract/relayer/deploy tooling); relayer v2 in a separate repo (armada-relayer#26).
3. **Own the SDK's vendored value-types natively** — pinned to the **custom-circuits milestone** (when Armada's own ZK circuits + verifiers replace the vendored Railgun ones per `ARCHITECTURE_NOTES.md`; the value-types get redefined then anyway).
4. **Rename `railgunAddress` → `shieldedAddress`** — cross-repo (SDK `Keyset`/`deriveKeyset` public field → interface `keyManager`/atoms/`ShieldedWalletState`). Internal identifier (not a runtime-emitted string, so not a naming-rule violation) — a clarity nicety tracked in SDK SPEC §4.2.
5. **Future investigation** — push / new-block-driven sync trigger (armada-sdk#59). RPC scan stays the trust anchor; watcher optional + verified.

## Key risks (retired)

Identity/address parity, the native quicksync path (`/v2` + root verification), and native tx-history design all landed and are in production use in the interface. The remaining open risk is the at-rest encryption model (Remaining #1).

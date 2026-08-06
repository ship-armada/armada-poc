# Interface → @armada/sdk Migration Plan

Status: planning (2026-08). Read alongside `.claude/PLAN_ARMADA_INTERFACE.md` (the interface's own architecture doc).

## Guiding principle (locked)

The SDK, relayer, and interface are all **pre-production**. Optimize for long-term-clean solutions; make whatever changes are needed to get there. **Never lock into a Railgun-inherited shape for short-term compatibility ease.** End goal: remove `@railgun-community/*` as a dependency **entirely**. The SDK is meant to be consumed by future apps, so its public API must be **SDK-owned**, not a Railgun passthrough.

The interface is **alpha** — re-platform onto the SDK's native model; do NOT build engine-compat shims.

## Native-not-ported rules (HARD)

When migrating an interface capability onto the SDK, build the **native** equivalent. Do not port the Railgun convenience just because the interface uses it today:

1. **Tx history** — design a native read API off the SDK's own scan state (TXOs / decrypted notes / spent nullifiers). Do NOT mirror `getWalletTransactionHistory` or the `TransactionHistoryItem*` types.
2. **Gas** — drop the `EVMGasType.Type1/Type2` + `overallBatchMinGasPrice` ceremony. That's a Railgun `populate*` artifact; native calldata construction (`buildTransactCalldata`) needs only `boundParams.minGasPrice` for relayer-submitted txs. This is a **deletion**, not a reimplementation.
3. **Wrappers / adapt** — expose the proved struct natively (`ProofHandle.toTransactionData()`) and hand-encode the Armada wrapper calldata (`atomicCrossChainUnshield` / `lendAndShield` / `redeemAndShield`) from it. Do NOT reintroduce Railgun `generateProofTransactions` / `relayAdaptID` / RelayAdapt. We already model `adaptContract` / `adaptParams` natively.
4. **Sync / events** — SDK-native `EventSource` (getLogs default + native `/v2/quick-sync` indexer) + typed `SyncEventMap`. Do NOT preserve the engine's global balance callback, quicksync-callback, or LevelDB model.
5. **Identity / storage** — `fromRootSecret` + a StorageAdapter, and own the at-rest encryption (encrypt the whole namespace — the deferred "Option B"). Do NOT depend on the engine's `putEncrypted` / `clearDecryptedBalancesAllTXIDVersions` semantics.

## Sequencing

- **Gate 0 — SDK additions (native, unblock the migration):**
  - Quicksync `EventSource` + native `/v2/quick-sync` wire contract — *in progress* on `armada-sdk` `feature/quicksync-event-source` (wire contract landed; Rpc/Indexer sources + root-verify next).
  - Native tx-history read API.
  - `ProofHandle.toTransactionData()` accessor.
  - Confirm broadcaster-fee output on `planTransfer`/`prove` (the `FeeRequest` path).
- **Phase A — read path:** `createArmadaSdk` instance + IndexedDB `StorageAdapter` + identity (parity-checked against existing engine addresses) + sync/balances via `SyncEventMap`. **Shadow-differential first** (SDK balances vs engine balances, no behavior change), then cut over.
- **Phase B — write path (easiest → hardest):** shield → transfer / unshield-local → xchain-unshield → yield.
- **Phase C — history + nullifier cross-check + at-rest encryption** on the SDK model.

## Railgun-removal end-state milestone

An explicit completion gate — the flags below are **transitional scaffolds**, not a permanent dual-backend:

- Delete all stock / `SDK_BACKEND=stock` paths (v1 relayer + `lib/sdk` seam); relayer v2 armada-only (armada-relayer#26); interface armada-only.
- **Zero `@railgun-community/*` dependencies** anywhere in the tree.
- **Own the SDK's public value-types natively** — `TokenData`, `Chain`, `AddressData`, `Ciphertext`, and the `ChainType` / `TokenType` / `TXIDVersion` enums — replacing the vendored re-exports in `src/core/index.ts`. Natural point: **when the vendored engine is dropped for custom circuits** (these get redefined then anyway). Until then, the vendored re-exports are the SDK's documented owned contract — low lock-in risk (protocol-dictated shapes; no behavioral Railgun classes are public). Redefining earlier is churn: numeric-enum boundary friction for little near-term benefit.

## Capability map (from the read/write inventory)

| Interface capability | SDK status |
|---|---|
| Identity (rootSecret → 0zk) | ✅ `deriveKeyset` — verify address/walletId parity for existing users |
| Shield (random shieldPrivateKey) | ✅ `buildShieldRequest` — matches the app's random-key policy |
| Gasless / xchain shield | ✅ `buildGaslessShield` (+ cross-chain variant follow-up) |
| Transfer / unshield-local | ✅ `planTransfer`→`prove`→`buildTransactCalldata` |
| adaptParams (cctp / yield) | ✅ `encodeCctpBinding` + yield binding encoders |
| Proving / artifacts | ✅ `ProverAdapter` + `ArtifactSource` |
| Balances / sync | ⚠️ native scan engine; quicksync via new `/v2` EventSource (Gate 0) |
| Tx history | ❌ native read API needed (Gate 0) — do NOT port Railgun's |
| Proved struct for wrappers | ❌ `ProofHandle.toTransactionData()` needed (Gate 0) |
| Gas Type1/Type2 ceremony | 🗑️ delete — `populate*` artifact, not needed natively |
| At-rest encryption | ⚠️ re-express as StorageAdapter-level encryption (Option B) |

## Key risks

Identity/address parity for existing users; the native quicksync path (`/v2` + on-chain root verification); at-rest encryption model; native tx-history design.

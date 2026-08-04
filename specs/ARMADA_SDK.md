# Armada SDK

**Status:** Draft v1 — specification and implementation plan for `@armada/sdk`, a fork-and-shrink
replacement of the Railgun SDK stack (`@railgun-community/engine` 9.5.1, `wallet` 10.8.1,
`shared-models` 8.0.0).

**Audience:** an implementing agent starting fresh. This document is self-contained: it embeds the
conclusions of the July 2026 SDK-usage analysis (branch `iskay/railgun-sdk-usage-analysis`) and the
Claimable Shielded Payments brief, neither of which will necessarily be available later.

### Implementation readiness

| Section | Status |
|---|---|
| §1 Context, goals, constraints | Ready |
| §2 Compatibility contract (pinned crypto core) | Ready |
| §3 Package architecture | Ready |
| §4 Module specs: keys, enrollment & custody (SpendSigner, view-only) | Ready |
| §4 Module specs: storage | Ready |
| §4 Module specs: sync | Ready — indexer quick-sync interface is optional/deferred |
| §4 Module specs: prover | Ready |
| §4 Module specs: transaction building | Ready |
| §4 Module specs: preflight | Ready |
| §5 Payments layer (requests, incoming events, receipts) | Ready — receipt format decision open (§9) |
| §6 Claimable shielded payments | Ready — pending Phase 0 spike results |
| §7 Operations journal & cross-chain lifecycle | Ready |
| §8 Observability | Ready |
| §10 Implementation plan | Ready |
| Convert circuit / yield-accrual note model | Out of scope (circuit change) |
| POI, Waku broadcaster, NFT, V3, RelayAdapt | Out of scope (dropped) |

---

## 1. Context, goals, constraints

### 1.1 Why fork

Armada currently drives its shielded pool through the Railgun SDK. PR #373 replaced Railgun's
circuit artifacts with independently compiled `armada-circuits`; the SDK is the last Railgun layer.
The integration analysis found we use roughly 40% of the SDK, monkey-patch around another 20%, and
are feature-blocked by its API surface in at least three places:

- **#399** — cross-chain unshield must bind the CCTP destination into `boundParams.adaptParams`;
  reaching this through the stock SDK requires semi-private APIs. Currently code-blocked in
  `apps/armada-interface/src/lib/railgun/unshield.ts`.
- **TX_SIGNING v2 phase 2** — rootSecret-native enrollment. The stock SDK only accepts BIP-39
  mnemonic strings, forcing the shim in
  `apps/armada-interface/src/lib/railgun/wallet.ts` (`createSdkWalletFromRoot`).
- **WS7.2 Option B** — encrypted-at-rest note storage. The stock SDK persists decrypted note
  plaintext; full encryption requires wrapping its storage layer.
- **Paros-class integrations** (`specs/PAROS_INTEGRATION.md`) — external-signer custody ("no
  protected balance controlled solely by an agent hot key") and per-account view-only reporting
  wallets. The stock SDK ships `HardwareWallet`/view-only/multisig classes, but the connector
  interface is undocumented and unused by our code (an external-signer connector landed
  upstream in engine 9.6.0 — a useful design reference, not a dependency). Owning the SDK
  replaces that archaeology with a designed `SpendSigner` custody boundary (§4.2.1).

The Railgun SDK is MIT licensed. Fork-and-shrink is legally clean; MIT attribution must be
preserved on all vendored code (see §3.4).

### 1.2 Workaround inventory being eliminated

These exist today and are deleted by this project. The implementing agent should treat each as an
acceptance criterion ("this hack no longer exists") for the phase that owns it.

| Workaround | Location | Eliminated by |
|---|---|---|
| `NETWORK_CONFIG` monkey-patch (no register-custom-network API; Sepolia entry neutralized with chainId −1) | `apps/armada-interface/src/lib/railgun/network.ts`, `scripts/check_relayer_railgun_balance.ts` | §4.1 config model, Phase 2 |
| `overrideArtifact()` injection to bypass IPFS download + hash whitelist | `apps/armada-interface/src/lib/railgun/artifacts.ts`, `lib/sdk/armada-artifacts.ts` | §4.5 artifact model, Phase 2 |
| POI dummy interfaces / stubs to prevent crashes | `apps/armada-interface/src/lib/railgun/init.ts`, `lib/sdk/init.ts`, `scripts/check_relayer_railgun_balance.ts` | POI dropped entirely, Phase 1 |
| BIP-39 mnemonic shim for rootSecret enrollment | `apps/armada-interface/src/lib/railgun/wallet.ts` | §4.2, Phase 2 |
| Decrypted note plaintext at rest; lock-time cleanup via non-exported SDK method | `wallet.ts` `lockWallet` → `clearDecryptedBalancesAllTXIDVersions` | §4.3 storage encryption, Phase 2 |
| `yieldToPaint()` frame-yield hack; 20–30 s main-thread proof blocking | `unshield.ts`, `transfer.ts` | §4.5 worker prover, Phase 2 |
| Silent proof-cache contract (generate/populate must repeat byte-identical args or throw) | `unshield.ts`, `transfer.ts` | §4.6 ProofHandle, Phase 2 |
| Relayer fee verifier re-encodes wrapper calldata as synthetic `transact()` so the SDK can decode | `relayer/modules/broadcaster-fee-verifier.ts` | §4.6 native decode API, Phase 2 |
| Stale-DB-after-redeploy ("delete `data/railgun-db/`") | CLAUDE.md Common Pitfalls | §4.3 schema versioning, Phase 2 |
| Three separate LevelDB paths to dodge single-process locks | `lib/sdk/init.ts`, relayer, balance script | §4.3, Phase 2 |
| Dynamic-import ceremony (circomlibjs crashes jsdom); Node-polyfill Vite scaffolding for level-js | all of `src/lib/railgun/`, `vite.config.ts` | browser-first packaging, Phase 1–2 |
| `@ts-ignore` / `as any` casts (snarkjs types, gas details, leveldown) | `lib/sdk/prover.ts`, interface tx modules | typed API surface, Phase 2 |
| Stale `snarkjsInitialized` module flag class of bugs | `lib/sdk/prover.ts` | §4.5 prover lifecycle, Phase 2 |

### 1.3 Constraints

1. **Circuit parity is frozen.** `armada-circuits` are a clean-room equivalent of Railgun's V2
   circuits. No circuit modifications are on the table. Everything in this spec works within
   existing circuit shapes and the existing `boundParams` hashing. Anything requiring a `.circom`
   change (convert circuit, in-circuit timelocks, CCTP-aware commitments, ZK selective disclosure)
   is out of scope.
2. **Byte-compatibility with the Railgun crypto core is permanent**, not transitional (§2).
3. **Contracts are not changed by this project.** The SDK targets the contract state
   **as of the PR #410 integration** (armada-circuits cutover + permissionless gasless shield
   + verifier fix — treated as the baseline; #410 is validation-gated but committed-to). That
   includes the wrapper entry points (`lendAndShield`, `redeemAndShield`,
   `atomicCrossChainUnshield`), the CCTP adaptParams binding, and the **permissionless
   gasless-shield wrappers**: no `onlyRelayer` gate; the user signs an EIP-712 shield intent
   binding the shield-note array so any relayer can submit without being able to alter
   recipient npk, fee, or integrator; cross-chain multi-note mints batch into a single
   `Shield` event. If #410 changes materially before merge, re-verify §4.6/§4.6.1 against the
   merged code.
4. **The relayer API is stable.** `POST /relay`, `GET /fees`, `GET /status/:txHash` semantics,
   the transact-path broadcaster-fee-output mechanism, and the shield-path fee-note mechanism
   (#410) are unchanged.
5. Repo-wide rules apply: TDD, no unrelated changes, `ABOUTME:` headers on new code files,
   pre-commit sensitive-data checks.

### 1.4 Non-goals (dropped Railgun functionality)

PPOI (proof of innocence) including the TXID merkletree sync it requires — **stripped at
vendor time, not stubbed; see §3.5** — the Waku broadcaster network, NFT/ERC-721/1155 support,
V3 contract support, RelayAdapt DEX integration, Railgun's multi-chain wallet sync, Railgun's
IPFS artifact distribution. (View-only wallets, dropped in
an earlier draft, are IN scope — they are load-bearing for integrator reporting; see §4.2.2.)

---

## 2. Compatibility contract — the pinned crypto core

The following MUST remain byte-for-byte compatible with `@railgun-community/engine` at the
vendored tag (`v9.6.0`, §3.4) — i.e. 9.5.1 behavior plus the upstream 9.5.2–9.6.0 correctness
fixes, which the POC's runtime pin is bumped to before vector capture (§10, Phase 0). They are pinned by circuit parity and by already-deployed on-chain state (existing
commitments/notes on Sepolia and any prior deployment a wallet may rescan).

| Primitive | Definition (as implemented by engine 9.5.1) |
|---|---|
| Key derivation | BIP-39/BIP-32 path → Baby Jubjub EdDSA spending keypair, Curve25519 viewing keypair, nullifying key = Poseidon-derived per engine; master public key = f(spendingPubKey, nullifyingKey) |
| Commitment hash | `Poseidon(notePublicKey, tokenHash, value)` |
| Note public key | derived from receiver master public key + `random` per engine |
| Nullifier | `Poseidon`-based `getNullifier(nullifyingKey, leafIndex)` |
| Note ciphertext (V2) | AES-256-GCM envelope + memo/annotationData layout, ECIES via Curve25519 shared key |
| Merkle tree | depth 16, 65 536 leaves/tree, Poseidon hashLeftRight, `MERKLE_ZERO_VALUE`, multi-tree rollover |
| Circuit shapes | the 19 compiled shapes (1×1 … per artifact set), flat `pathElements[N*16]`, signal names per PR #373 (`commitmentsOut` etc.) |
| boundParams hashing | struct layout and hash as consumed by `armada-circuits` / verifier (`keccak256(abi.encode(boundParams)) % SNARK_SCALAR_FIELD` — stock Railgun; keccak on-chain, consumed as a field element by the circuit) |
| Spend authorization message | Baby Jubjub EdDSA signature over `poseidon([merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut])`, consumed as a private witness by the circuits (engine 9.5.1 `railgun-wallet` behavior; on-chain public-input ordering per `contracts/railgun/logic/Verifier.sol`) |
| TXIDVersion | `V2_PoseidonMerkle` retained as the version tag in storage and proof inputs |
| Serialization | `TransactionStructV2` calldata layout for `transact()` |

**Enforcement:** the differential test harness from PR #373 (`scripts/capture/`) becomes a
permanent fixture. Phase 1 extends it into a vector suite (§10.2) that runs the armada-sdk
implementation against captured stock-engine outputs. Any divergence is a release blocker.

Everything NOT in the table above is free to change. Explicitly free: the encryption *envelope
schema* for out-of-band payloads (claim envelopes, payment requests — these are new constructions,
not the note ciphertext), storage schema, sync strategy, artifact distribution, API surface,
`boundParams` *interpretation* (contract-side), memo *content* conventions layered inside the
existing memo field.

> **Memo-format caution:** the note memo/annotationData byte layout is part of the pinned core
> (recipients running any compliant scanner must decrypt it). Structured payment metadata (§5.1)
> is layered *inside* the memo text field as versioned content, not as a change to the envelope
> layout — and only ships once armada-sdk owns scanning on all consuming surfaces (interface,
> relayer viewing-key checks).

---

## 3. Package architecture

### 3.1 Location and packaging

- **Own repository: `ship-armada/armada-sdk`** (already reserved in the org; follows the
  `armada-circuits` spin-off precedent), package name `@armada/sdk`. The canonical copy of this
  spec moves into that repo as `SPEC.md` at bootstrap; the POC repo keeps a pointer.
- **Test split across repos:** the SDK repo holds all unit/property tests and the differential
  vector *fixtures* (offline — no chains, fast CI); the POC repo holds the vector *capture*
  scripts and all integration/e2e tests (Anvil + deployed contracts + relayer live there),
  consuming pinned prerelease builds of the SDK (GitHub Packages `0.x.y-dev.N` preferred; a git
  dependency pinned to a commit SHA is the acceptable low-infra alternative). The
  compatibility contract travels between repos as fixture data, not coupled code.
- **Browser-first, Node-compatible.** No Node built-ins in core modules; environment adapters
  (storage, workers) are injected. Target: the Vite `nodePolyfills`/`level-js` scaffolding in
  `apps/armada-interface/vite.config.ts` becomes removable, except what snarkjs itself needs.
- Single package with subpath exports (`@armada/sdk/core`, `/wallet`, `/payments`, `/ops`), not a
  three-package split — the engine/wallet/shared-models triple with version skew is one of the
  things being fixed.

### 3.2 Layering

```
┌────────────────────────────────────────────────────────────┐
│ apps / relayer / scripts                                   │
├────────────────────────────────────────────────────────────┤
│ @armada/sdk                                                │
│                                                            │
│  payments/   claim envelopes, payment requests, receipts,  │
│              incoming-transfer events          (§5, §6)    │
│  ops/        operation journal, cross-chain lifecycle,     │
│              sweep scheduler                   (§6.6, §7)  │
│  wallet/     enrollment, wallet lifecycle, balances,       │
│              TXO set, importNote, sync orchestration (§4)  │
│  tx/         TransactionBatch, ProofHandle, fee binding,   │
│              preflight, calldata encode/decode (§4.6–4.7)  │
│  prover/     worker-based Groth16, artifact registry (§4.5)│
│  storage/    versioned, encrypted, env-adapted     (§4.3)  │
│  sync/       event scan, bisecting RPC, merkle build (§4.4)│
│ ┌──────────────────────────────────────────────────────┐   │
│ │ core/  — PINNED, vendored from engine 9.5.1 (§2)     │   │
│ │ keys · notes · poseidon · merkle math · nullifiers   │   │
│ │ · note ECIES · shapes · serialization                │   │
│ └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

`core/` changes only for bug-for-bug compatibility fixes, verified by the vector suite. All
product work happens in the layers above it.

### 3.3 Configuration model

No global network registry. The SDK is configured per-instance from the deployment manifest
shape the repo already produces (`deployments/`, served to the interface via
`/api/deployments/...`):

```ts
interface PoolConfig {
  chainId: number;
  poolAddress: `0x${string}`;
  deployBlock: number;
  usdcAddress: `0x${string}`;
  wrappers?: { gaslessShield?: `0x${string}`; yieldAdapter?: `0x${string}` };
  cctp?: { domain: number; messenger: `0x${string}` };
}
```

`config/networks.ts` remains the single source of truth for chain/CCTP data; manifests carry
per-deployment addresses. `createArmadaSdk({ pool: PoolConfig, storage, prover, rpc })` replaces
`startRailgunEngine` + `loadProvider` + NETWORK_CONFIG patching. Multiple instances in one
process are supported (kills the LevelDB-path juggling; the relayer, tests, and scripts each
construct their own instance).

### 3.4 Vendoring and licensing

- Vendor the needed engine source (TypeScript sources, not dist) from the upstream
  `Railgun-Community/engine` repo at **tag `v9.6.0`** — the latest stable, NOT our
  package.json pin (9.5.1). The 9.5.2–9.6.0 range contains correctness/security fixes inside
  the pinned-core scope that must not be forked away: cross-tree nullifier-collision fixes in
  nullifier/spent-TXO retrieval (9.5.3, 9.5.4) and verification that a decrypted transact
  note's hash matches its on-chain commitment (9.6.0). Vendor into `vendor/railgun-engine/`
  with the upstream MIT `LICENSE` file preserved and a `NOTICE.md` recording upstream repo,
  tag, and commit SHA.
- **Tag↔npm verification (do not rely on package.json or the tag alone):** before vendoring,
  confirm the chosen git tag corresponds to the published npm artifact — check
  `package.json` version at the tag and spot-diff the tag's compiled output against the npm
  tarball for the same version. The npm artifact is what production code actually runs; the
  tag must match it. Record the verification in `NOTICE.md`.
- `core/` re-exports/adapts vendored modules; modifications to vendored files are allowed but
  each modified file gets a header line noting it diverges from upstream.
- `poseidon-hash-wasm`, `curve25519-scalarmult-wasm`, `circomlibjs`, `ffjavascript`, `snarkjs`
  remain external dependencies (they are the crypto engines, not the orchestration being
  replaced).

### 3.5 PPOI is stripped at vendor time, not stubbed

The current integration keeps POI code paths alive behind dummy interfaces; the SDK removes
them entirely — no POI code exists to stub:

- **Deleted from the vendor drop:** the `poi/` module, `POINodeInterface`, POI artifact
  getters and POI circuit handling in the prover (`getArtifactsPOI`, `provePOI`,
  `verifyPOIProof`), POI proof generation in transaction building, and the TXID merkletree +
  railgun-transaction sync machinery that exists only to serve PPOI.
- **Removed from adapted core signatures and types:** no `shouldGeneratePreTransactionPOIs`
  flag or `preTransactionPOIsPerTxidLeafPerList` return on transaction generation; no POI
  status fields in TXO storage records; the balance model collapses from Railgun's
  `WalletBalanceBucket` POI buckets to a simple spendable/pending model.
- **Guard:** Phase 1 acceptance includes `rg "POI" src/ vendor/` (case-sensitive — POI is
  uppercase in all upstream identifiers) returning nothing in the SDK repo.
- **Rationale:** PPOI is Railgun-network compliance infrastructure; nothing in Armada's
  contracts or circuits consumes POI data, and Armada's compliance story is voluntary
  selective disclosure (§5.3). Note: the 9.5.4 upstream fix titled "POI spentTXO filtering by
  tree" addresses a cross-tree nullifier-collision class — when stripping, verify the
  underlying tree-scoped TXO/nullifier filtering fix survives in the non-POI spentness logic;
  do not strip the fix along with the POI wrapper.

---

## 4. Module specifications

### 4.1 Instance lifecycle

```ts
const sdk = await createArmadaSdk({
  pool: PoolConfig,
  rpc: { urls: string[], pollIntervalMs?: number },
  storage: StorageAdapter,          // §4.3
  prover: ProverAdapter,            // §4.5
  artifacts: ArtifactSource,        // §4.5
  telemetry?: TelemetrySink,        // §8
});
await sdk.close();                  // releases storage, terminates workers
```

- No singletons, no module-level mutable state (the `snarkjsInitialized` bug class).
- All long operations accept `AbortSignal`.
- Typed error taxonomy (§8) — no string-matching on error messages anywhere in consuming code.

### 4.2 Keys & enrollment

Implements TX_SIGNING.md as amended by TX_SIGNING_V2_AMENDMENT.md. The `rootSecret` (32 bytes)
is the canonical identity; the SDK accepts it directly.

```ts
// Canonical: no mnemonic intermediary. Deletes the BIP-39 shim.
wallet = await sdk.wallet.fromRootSecret(rootSecret, {
  creationBlock: number,           // REQUIRED; hub deployBlock for first enrollment
});

// Ephemeral (in-memory only, never persisted): §6
eph = await sdk.wallet.ephemeralFromSeed(seed);

// Compat: BIP-39 accepted for the relayer's existing mnemonic-provisioned wallet only.
wallet = await sdk.wallet.fromMnemonic(mnemonic, { creationBlock });
```

Requirements:

- `fromRootSecret` derivation path: `rootSecret` → HKDF-SHA-256 with domain-separated tags →
  Baby Jubjub spending pair + Curve25519 viewing pair + nullifying key, using the **pinned core
  derivation** so the resulting keyset is exactly what the current
  `deriveRootSecret`/mnemonic-shim path produces today. **Load-bearing:** existing testnet
  wallets must resolve to the same 0zk address. Phase 0 spike pins this with vectors
  (§10.1). If byte-equality with the shim path is impossible without the mnemonic detour, the
  fallback is to keep the mnemonic construction *inside* `fromRootSecret` as an implementation
  detail — the API contract (raw bytes in, canonical keyset out, reproducible) is what matters.
  Phase 0 Spike 1 (engine 9.6.0) — CONFIRMED: `fromRootSecret` retains the BIP-32 mnemonic
  detour (`deriveInternalMnemonic` → `createWalletFromMnemonic`) internally. It reproduces the
  full keyset byte-for-byte across independent engine instances
  (`scripts/capture/vectors/keyset-vectors.json`) and resolves a live testnet wallet to its
  exact on-chain 0zk address (`0zk1…cutqe08`). Direct HKDF would yield a different keyset (the
  documented Phase-1/Phase-2 non-interop); the detour is retained to preserve testnet identity.
  Load-bearing requirement satisfied.
- Baby Jubjub validity checks on all derived/imported keys: subgroup membership, non-zero
  scalars, canonical encodings. Reject, never clamp silently.
- Recovery-path parity per TX_SIGNING v2: re-sign (deterministic EOAs, double-sign verification
  at enrollment), paste-secret, backup file. Backup-file AES-256-GCM format is carried over
  from `apps/armada-interface/src/lib/crypto/kdf.ts` unchanged.
- Zeroization discipline: key material in `Uint8Array` only, `fill(0)` in `finally` blocks;
  never `string` types for secrets in SDK APIs.
- `walletId` derivation stays deterministic per (rootSecret, derivationIndex) so relayer restart
  recovery keeps working.

#### 4.2.1 Custody boundary — `SpendSigner`

Key custody is an **interface, not an assumption**. The wallet layer separates *constructing*
the spend authorization message (the pinned poseidon digest, §2) from *producing* the EdDSA
signature over it:

```ts
interface SpendSignRequest {
  message: bigint;                       // the pinned poseidon digest ("intent digest")
  context: {                             // fully-bound intent, human/policy-inspectable
    nullifiers: bigint[];
    commitmentsOut: bigint[];
    merkleRoot: bigint;
    boundParams: DecodedBoundParams;     // incl. adaptContract + decoded adaptParams
    summary: PlanSummary;                // token, amounts, outputs, fee output
  };
}

interface SpendSigner {
  getSpendingPublicKey(): Promise<[bigint, bigint]>;
  signBatch(requests: SpendSignRequest[]): Promise<EddsaSignature[]>;
}
```

- **Batch semantics are part of the contract:** the signer receives the *entire batch* of
  fully-bound intents (including decoded adapt calldata) before releasing any signature —
  "approve one signature = approve one fully-bound intent" is a property of the interface, not
  a hope about a hook.
- Implementations: `LocalSigner` (derived from rootSecret; the default and everything the repo
  does today), `ExternalSigner` (delegates to an out-of-process signer service — HSM, enclave,
  policy-gated; transport and gating are defined by the consuming integration, e.g.
  `specs/PAROS_INTEGRATION.md`, **not** by the SDK), and later `ThresholdSigner` (FROST on Baby
  Jubjub — a pure signer swap; circuits/contracts/tx semantics see a standard EdDSA signature).
- Signing happens during witness assembly: `sdk.prover.prove(plan)` requests signatures from
  the wallet's attached `SpendSigner` before proof generation. External-signer latency
  therefore gates proving; the `ProofHandle` TTL model (§4.6) is the vehicle for
  signature-release → submission time-bounding.
- **Signature lifecycle (must-document):** a signed/proved transaction has **no on-chain
  expiry** — it stays valid until one of its input notes is nullified. TTL enforcement is a
  signer-service/app policy. Emergency revocation = spend one input note elsewhere to consume
  its nullifier; the SDK supports building such a revocation spend as an ordinary self-transfer.
- Nothing integration-specific (Salt, Paros policy, transports) enters the `armada-sdk` repo;
  the SDK ships the interface, `LocalSigner`, and an in-process test double for
  `ExternalSigner`.

#### 4.2.2 View-only wallets

A wallet is **viewing capability ± spend capability**; a view-only wallet is a wallet with no
`SpendSigner` attached:

```ts
viewWallet = await sdk.wallet.viewOnlyFromViewingKey(shareableViewingKey, { creationBlock });
```

- Full scan/balance/history/`note:received`/disclosure-export capability; any spend-path call
  fails with a typed `NoSpendCapabilityError`.
- Shareable-viewing-key encoding stays compatible with the stock `fromShareableViewingKey`
  format (existing keys keep working).
- **Irrevocability is a documented product constraint:** a shared viewing key is permanent for
  that wallet's entire history; "rotation" = new wallet + balance migration. The SDK exposes
  this as a first-class note in API docs and telemetry never logs viewing keys.
- This is the reporting/reconciliation primitive for integrators (one view-only wallet per
  account = one disclosure boundary) and is already proven in-stack by the relayer's
  viewing-key fee verification.

### 4.3 Storage

```ts
interface StorageAdapter {           // environment adapters provided by the SDK:
  // browser: IndexedDB (native, no level-js); node: classic-level or SQLite
}
```

Requirements:

- **Schema versioning + deployment binding.** Every store namespace is keyed by
  `(schemaVersion, chainId, poolAddress, deployBlock)`. On open, mismatch with the configured
  `PoolConfig` triggers an automatic targeted reset of chain-derived state (merkle, TXOs, scan
  checkpoints) while preserving wallet identity records. This deletes the "stale DB after
  redeploy → delete `data/railgun-db/`" pitfall.
- **Encrypted at rest (WS7.2 Option B).** All decrypted note data, TXO records, balances, and
  history caches are AEAD-encrypted under a storage key derived from the wallet's rootSecret
  (HKDF, domain-separated). Chain-public data (merkle nodes, commitment ciphertexts as seen
  on-chain) may be stored in plaintext. Locking a wallet = dropping the storage key; there is no
  plaintext to scrub, so tab crash leaks nothing.
- **Multi-instance safe.** No process-wide lock files. Browser: one IndexedDB per
  (pool, origin); Node: per-instance path from config with advisory locking and a clear typed
  error on conflict.
- Ephemeral wallets (§6) never touch the StorageAdapter.

### 4.4 Sync

Requirements:

- **Event scan from RPC** is the baseline: Shield/Transact/Nullify events from `deployBlock`
  (or wallet `creationBlock`), building the UTXO merkletree exactly as the pinned core defines.
  The `eth_getLogs` bisecting logic currently monkey-patched into ethers
  (`relayer/lib/rpc-bisecting.ts`, duplicated in the interface) moves **into** the sync module
  as first-class ranged fetching with per-provider range adaptation.
- **Merkle root verification** against the pool contract after each batch (validator callback
  equivalent), with typed `RootMismatchError` carrying tree/index context.
- **Progress + events.** `sdk.sync.status()` and subscription events
  (`scan:started/progress/complete/error`, `balance:updated`, `note:received` — see §5.2)
  replace the single global `setOnBalanceUpdateCallback` multiplexer.
- **Checkpointing.** Scan checkpoints per (wallet, chain) live in storage (replacing the
  localStorage `history-checkpoint.ts`), covered by the schema-version reset rule.
- **Quick-sync interface (optional, deferred within Phase 2):**
  `interface EventSource { getEvents(fromBlock, toBlock): Promise<AccumulatedEvents> }` — an
  indexer-backed implementation can later serve snapshots to cut first-scan time (the crowdfund
  indexer infra is prior art). RPC scan is always the verification fallback: quick-sync results
  are verified against on-chain roots before acceptance.
- The engine-global merkletree is shared across wallets in one instance (this matches stock
  behavior and is load-bearing for `importNote`, §6.4).

### 4.5 Prover & artifacts

Requirements:

- **Worker-first.** Proof generation runs off the main thread: Web Worker (browser) /
  `worker_threads` (Node) adapters ship with the SDK. snarkjs and WASM artifacts load inside the
  worker. The API is identical either way; a same-thread fallback exists for constrained test
  environments. Real progress events (`proof:progress` with phase + fraction) replace the
  `yieldToPaint()` hack.
- **Artifact model.** `ArtifactSource` resolves `(shape) → {wasm, zkey, vkey}` from
  `armada-circuits/build/` — filesystem (Node), HTTP origin `/artifacts/` + IndexedDB cache
  (browser). Integrity: SHA-256 manifest generated by the circuits build, checked on load. No
  IPFS, no Railgun hash whitelist, no `overrideArtifact` injection.
- Shape selection logic vendored from core (input/output counts → artifact id) unchanged.
- Local verification (vkey check of a generated proof) available for tests and preflight
  self-checks.

### 4.6 Transaction building

Replaces `TransactionBatch` orchestration and the wallet-package tx services with a typed,
explicit pipeline. UTXO selection and calldata serialization are vendored core behavior.

```ts
const plan = await wallet.planTransfer({
  outputs: [{ to0zk, amount, memo? }],
  unshield?: { recipient, amount, adaptParams? },   // adaptParams: CCTP binding, yield binding
  fee: FeeQuote,                                    // §4.6.1
});
// plan: selected TXOs, change output, shape, fee output — inspectable before proving

const handle: ProofHandle = await sdk.prover.prove(plan, { signal, onProgress });
const tx = handle.toTransactCalldata();             // { to, data, value }
```

- **ProofHandle** owns the proof and the exact plan it proves. Populate-time argument
  re-matching (the stock SDK's silent cache contract) does not exist; a handle either encodes
  its own calldata or is explicitly invalid (`handle.invalidate()`, TTL, or plan-state change).
- **Signing is a pipeline stage:** `prove()` obtains EdDSA signatures from the wallet's
  `SpendSigner` (§4.2.1) during witness assembly — local wallets sign inline; external signers
  are awaited (with `AbortSignal` support) before proving starts.
- **adaptParams is a first-class typed input.** Provided encoders ship for the deployed
  contracts: `encodeCctpBinding(recipient, destDomain, maxFee)` (fixes #399's API gap) and the
  yield adapter binding (parity with current `encodeYieldAdaptParams` /
  `encodeYieldAdaptParamsWithFee`). Wrapper call encoding (`lendAndShield`, `redeemAndShield`,
  `atomicCrossChainUnshield`) is provided as calldata builders.
- **Decode API for verifiers.** `sdk.tx.decodeTransact(calldata)` understands both bare
  `transact()` and the wrapper entry points natively and exposes
  `extractFeeOutput(viewingKey)` — replacing the relayer's synthetic-calldata normalization in
  `broadcaster-fee-verifier.ts` with a supported API. For the shield path, the SDK provides
  the **npk-reconstruction fee verification** primitive (per #410's v1 relayer): given a
  shield request, reconstruct the fee note's npk from the relayer's own keys and verify the
  note is addressed to the relayer's 0zk with value ≥ the advertised fee.
- **Shield.** `sdk.shield.buildRequest(...)` ports the `ShieldNoteERC20`/ECIES bundle
  construction (`lib/sdk/shield.ts`, interface `shield.ts`) onto core primitives, targeting
  the #410 gasless-shield model:
  - **Two-note construction** — the user's shield note plus a relayer fee note addressed to
    the relayer's 0zk (fee paid shielded, not in public USDC);
  - **EIP-712 shield-intent signing** binding the full shield-note array (recipient npk, fee
    note, integrator), enabling any-relayer submission with nothing alterable in transit;
  - the **permit-based gasless path** (token permit + intent, no user gas);
  - the **cross-chain variant** — fee note carried across CCTP and minted on the hub, with
    the multi-note mint batched into a single `Shield` event.

#### 4.6.1 Fee binding

`FeeQuote` is a typed object mirroring the relayer's `/fees` response (schedule, broadcaster 0zk
address, `feesCacheId`, TTL). Fees are bound in-band on both paths:

- **Transact path:** `planTransfer` computes the fee output note to the broadcaster's 0zk
  address from the quote and includes it in the plan; the proof then commits it.
- **Shield path (#410):** `buildRequest` computes the relayer fee note (§4.6 Shield) with
  **grossed-up fee tiers** so the relayer nets its target amount *after* the on-chain shield
  fee is applied — the gross-up math is part of the SDK's fee model, not left to callers.

The SDK's fee math MUST be tested against `FEE_STRUCTURE.md` and the fee-module contract
behavior on both paths (this is where the tracked shield-fee formula mismatch shortcut is
retired — the SDK computes what the contract enforces, verified by integration test, not a
parallel formula).

### 4.7 Preflight

`sdk.preflight(plan)` runs cheap RPC checks before proving and returns typed findings:

- merkle root of the plan still accepted by the pool (root freshness),
- no input nullifier already spent on-chain,
- shield-pause controller state (for shield plans),
- fee quote unexpired and consistent with current fee-module state,
- CCTP domain/messenger liveness for cross-chain plans,
- balance sufficiency including fee output.

Callers decide policy; the SDK never silently proceeds past a failed check it was asked to run.
The 30-second-proof-then-revert failure mode becomes a pre-proof typed error.

---

## 5. Payments layer

### 5.1 Payment requests

A versioned encoding (URL + QR payloads) of `{version, chainId, poolAddress, to0zk, amount?,
token, memoContent?, requestId?}`. Pure encoding/decoding — no server component. Shares its
versioning/encoding infrastructure with claim envelopes (§6.3); implement once.

Structured memo content (invoice/request ids, refund 0zk address) is a versioned schema carried
*inside* the existing memo text field (see §2 memo caution for sequencing).

### 5.2 Incoming-transfer events

The sync module emits `note:received` with the decrypted note (amount, token, memo content,
sender 0zk if disclosed) as a first-class typed event when scanning registers a new TXO for a
loaded wallet — replacing the interface's inference-from-balance-change
(`useIncomingTransferDetector`).

### 5.3 Receipts (selective disclosure)

`wallet.exportDisclosure(txoRef)` produces a verifiable receipt for one note: enough of the note
preimage/shared-key material for a verifier to recompute the commitment hash and check inclusion
against the on-chain tree, without revealing anything about other notes. Format: reuse/extend the
existing disclosure-bundle format (per the claims brief's recommendation — do not invent a second
receipt format; resolve in Phase 3 design, §9). ZK-proof-based disclosure is out of scope
(circuit change).

---

## 6. Claimable shielded payments ("cheque semantics")

### 6.1 Mechanism (normative summary)

A sender pays **any** Ethereum address, enrolled or not. The sender derives a fresh **ephemeral
wallet** (full canonical keyset from one 32-byte seed), funds a standard shielded note owned by
it, and delivers the seed to the recipient inside an encrypted **claim envelope** (link / QR /
message). To claim, the recipient enrolls (one EIP-712 signature) and the ephemeral wallet
executes an ordinary in-pool transfer of the note to the recipient's own shielded keys, via the
relayer, so the recipient's `0x` address never appears in calldata. To revoke, the **sender**
executes the same transfer back to itself. **First valid nullifier spend wins, atomically** — the
pool arbitrates; expiry and revocability are wallet policy, not chain rules.

**Protocol impact: none.** No circuit changes, no contract changes, no relayer changes (a claim
transfer carries a normal broadcaster-fee output to the relayer's 0zk address, which is exactly
what `broadcaster-fee-verifier` checks).

**Forbidden designs** (from the source brief; restated because the brief will not be available):
no server-side claim-code→address mapping, no on-chain escrow contract, no relayer custody of
seeds or re-shielding on the recipient's behalf. The seed stays client-side (or in an org signer
enclave, out of scope here). The relayer remains a dumb broadcaster that cannot read the payload.
If an implementation grows a `/claim` escrow endpoint or a claims table keyed by secret, it is
wrong.

### 6.2 Claim-seed derivation (fund-safety critical)

```
seed = HKDF-SHA-256(
  ikm  = senderRootSecret,
  salt = "armada/claim-seed/v1",              // domain tag, distinct from every kdf.ts tag
  info = nonce
)
nonce = SHA-256(recipientBinding ‖ amount ‖ counter)
```

- `recipientBinding`: recipient EVM address (lowercased) or, in bare-link mode, a random 32-byte
  binding id.
- `counter`: strictly monotonic per sender wallet, persisted in storage **and reserved before
  seed derivation** (write-ahead: the counter value is committed to storage before any note is
  funded; crash between reservation and funding burns a counter value harmlessly).
- **Nonce uniqueness is the single highest-severity correctness property.** Seed reuse across
  two payments gives two recipients each other's money. The spec-level uniqueness argument:
  counter monotonicity ⇒ distinct `info` ⇒ distinct HKDF output, regardless of
  recipient/amount collisions. Tests MUST include: vector fixtures, a property test that
  distinct counters never collide, crash-recovery tests around counter reservation, and a
  multi-tab/multi-device note (counter is per storage instance — two devices sharing a
  rootSecret use disjoint counter spaces via a per-installation salt component; document and
  test).
- Domain-separation tags must be globally unique across `kdf.ts`, `eip712.ts`, storage-key
  derivation (§4.3), and this scheme; maintain a single registry constant file in the SDK.

### 6.3 Claim envelope

Versioned payload:

```
{ version, chainId, poolAddress, seed, noteLocator: { commitment, tree, index, blockHint },
  advisoryExpiry, memo? }
```

- **ECIES suite v1:** ephemeral secp256k1 ECDH → HKDF-SHA-256 → AES-256-GCM (implemented on
  `ethereum-cryptography` primitives; this is a *new* out-of-band construction, distinct from
  and not constrained by the pinned Curve25519 note ECIES). Suite id embedded; envelope format
  is published/versioned for future cross-wallet interop.
- **Recipient pubkey resolution**, in preference order: (1) recover from any historical
  transaction signature of the recipient address; (2) `ecrecover` from an out-of-band EIP-712
  enrollment signature; (3) **bare-link mode** — symmetric key in the URL fragment; the link
  *is* the money, so bare-link claims are policy-capped (value ceiling + short advisory expiry;
  caps configurable, enforced at creation time in the SDK).
- Directory options (ENS text records etc.) are an open product decision (§9) — the resolver
  interface accepts pluggable sources but ships with only (1)–(3).

### 6.4 `importNote` — targeted note import (new core-adjacent API)

The claiming side must not full-scan as the ephemeral wallet. Because the merkletree is
instance-global and the claiming user's app has already synced it for their own wallet (§4.4):

```ts
const txo = await sdk.wallet.importNote(ephemeralWallet, noteLocator);
```

- Reads the commitment ciphertext/leaf at `(tree, index)` from the synced tree (falling back to
  a ranged event fetch around `blockHint` if the local tree lags), decrypts with the ephemeral
  viewing key, verifies the commitment hash matches the leaf, verifies non-nullified on-chain,
  and registers the TXO in the ephemeral wallet's in-memory TXO set.
- `planTransfer` must accept wallets whose TXO set was populated by import rather than scan.
- This is the largest single net-new item touching near-core code paths; it is Phase 3's first
  deliverable and gets its own integration tests (locator wrong/stale, note already spent,
  tree not yet synced past the locator).

### 6.5 Claim and reclaim flows

Both are `planTransfer` + `prove` + relayer submit, exactly as §4.6 — the ephemeral wallet
transfers its single note to the recipient's (claim) or sender's (reclaim) 0zk address, fee
taken from the amount via the standard broadcaster-fee output.

- Ephemeral wallets are **in-memory only** (§4.2, §4.3): loaded from seed, used for one plan,
  discarded. No wallet records, no decrypted balances, no seed material ever hit storage on
  either side (the *envelope* may be persisted by the app; the SDK never persists the seed).
- Race behavior: the loser's transaction fails on the spent nullifier. The SDK surfaces this as
  a typed `NoteAlreadySpentError` from preflight (§4.7) or from the on-chain failure, so claim
  UIs can say "this payment was revoked/already claimed" rather than showing a revert.

### 6.6 Sender-side lifecycle: pending claims and sweep

Built on the operations journal (§7):

- `pendingClaims` — persisted, encrypted records: `{counter, recipientBinding, amount,
  noteLocator, advisoryExpiry, envelopeFingerprint, status}`. Status transitions:
  `created → funded → claimed | swept | expired-pending-sweep`.
- **Sweep scheduler:** after `advisoryExpiry` plus a **mandatory grace period** (default 24 h,
  configurable but not below a floor — protects a claim in flight near the boundary), the SDK
  surfaces sweep-eligible claims; sweeping is an explicit app-triggered reclaim (§6.5), not an
  autonomous SDK action.
- Claim detection: the sender observes the note's nullifier being consumed (sync event) and
  resolves the pending claim to `claimed`/`swept` accordingly.

### 6.7 Claim UX doctrine (app-layer, stated here as requirements on SDK surface)

A legitimate claim requires **zero token approvals, zero contract interactions, one EIP-712
typed signature** — this structural anti-phishing property must be preserved by the SDK's claim
API shape (nothing in the claim path may require the recipient to sign a transaction). The
"sender can cancel until you claim" revocability notice and the canonical IPFS-pinned fallback
claim domain are app/infra work, out of SDK scope but recorded here so the handoff is complete.
Smart-account recipients (non-deterministic signers) take the existing backup-file/paste-secret
enrollment fallback (§4.2). Organisational custody (enclave-held `deriveClaim`, float caps) is
explicitly out of scope for the SDK; the derivation scheme (§6.2) is designed so an enclave can
implement it against the same spec later.

---

## 7. Operations journal & cross-chain lifecycle

- `ops/` maintains a persisted, encrypted, crash-safe journal of multi-step operations:
  cross-chain shield/unshield (`initiated → burned → attested → minted → scanned`, with CCTP
  attestation polling in `real` mode and mock progression locally), pending claims (§6.6), and
  in-flight single-chain submissions (`proved → submitted → confirmed → scanned`).
- Journal entries are resumable on instance restart: `sdk.ops.resume()` re-attaches watchers
  (attestation polling, nullifier watching, receipt polling) for every non-terminal entry.
- Typed status events feed both the interface (progress UI for multi-minute flows) and the
  relayer (same machinery headless).
- The journal is the single source of truth for "what is outstanding" — UIs must not
  reconstruct operation state from chain scanning alone.

---

## 8. Observability & errors

- **Typed error taxonomy**, exported: `RootMismatchError`, `NoteAlreadySpentError`,
  `FeeQuoteExpiredError`, `ArtifactIntegrityError`, `StorageConflictError`,
  `NonDeterministicSignerError`, `ClaimSeedCounterError`, etc. Every SDK error carries a stable
  `code` string; consuming code and tests match on codes, never message text.
- **TelemetrySink interface** (injected, no-op default): structured events for scan progress and
  durations, proof timings per shape, RPC failover/bisect activity, preflight outcomes, journal
  transitions. Feeds Sentry in the interface and the relayer's monitoring per `MONITORING.md`.
  Events MUST NOT contain key material, seeds, memo plaintext, amounts-with-identity, or 0zk
  addresses — telemetry payload review is part of code review for this module.

---

## 9. Open decisions (resolve during implementation, in-phase)

| # | Decision | Phase | Lean |
|---|---|---|---|
| 1 | Receipt format: extend existing disclosure bundle vs new format | 3 | Extend existing (do not invent a second format) |
| 2 | Node storage backend: classic-level vs SQLite | 2 | classic-level (smallest migration from leveldown) |
| 3 | Quick-sync indexer: build now vs later | 2 (defer ok) | Define interface now, implement later |
| 4 | Claim-envelope AEAD: AES-256-GCM vs XChaCha20-Poly1305 | 3 | AES-256-GCM (WebCrypto-native, matches backup format) |
| 5 | Recipient directory (ENS text records, integrator-held, none) | 3+ | Ship resolver orders (1)–(3) only; directory is product work |
| 6 | `fromRootSecret` internal path — detour vs direct-HKDF | 0 ✓ RESOLVED | Retain BIP-32 mnemonic detour internally. Spike 1 (engine 9.6.0) verified byte-reproducibility + a live testnet wallet resolving to its exact 0zk. Direct-HKDF (fresh identity) rejected — breaks testnet continuity. API contract unchanged. |
| 7 | Per-installation counter salt scheme for multi-device claim counters | 3 | Random per-installation component mixed into `info`; document |
| 8 | `ExternalSigner` out-of-process transport (HTTP vs socket vs enclave RPC) | Integration project | Not an SDK decision — SDK freezes the in-process interface; transport defined per integration (`specs/PAROS_INTEGRATION.md`) |

---

## 10. Implementation plan

Phases are sequential; each has acceptance criteria and lands behind integration flags so the
stock SDK path keeps working until Phase 5. Per repo policy every phase ships unit +
integration + e2e coverage; test output pristine.

### Phase 0 — Spikes and vector capture (stock SDK; throwaway code, permanent vectors)

1. **Upstream refresh (before capture).** Bump the POC's pinned `@railgun-community` packages
   to the latest stable (engine `9.6.0`, wallet `10.9.0`, shared-models `8.0.1`) and re-verify
   `npm run test:all` + the interface smoke flows. Rationale: vectors must be captured from
   the same version we vendor (§3.4), and the 9.5.2–9.6.0 range contains
   nullifier-collision and note-validation fixes we want in the running system regardless.
   Fallback if the bump is disruptive: capture on 9.5.1 and document each intentional
   divergence of the vendored 9.6.0 core as an annotated vector exception — do not silently
   mix versions.
2. **Seed → wallet reproducibility spike.** Derive a rootSecret via a domain-separated KDF,
   create a stock-SDK wallet from it (through the existing shim path), reconstruct
   independently, compare full keysets byte-for-byte. Capture vectors: rootSecret → spending
   priv/pub, viewing priv/pub, nullifying key, masterPublicKey, 0zk address.
3. **Claim-as-transfer spike.** Fund an ephemeral wallet's note on local Anvil; build and
   submit a transfer of that note to a normal user wallet through the existing
   `transfer-shielded` path + relayer. Confirm: recipient `0x` absent from calldata,
   broadcaster fee verified, race behavior (second spend of same note fails on nullifier).
4. **Vector suite expansion.** Extend `scripts/capture/` to emit fixtures for every pinned
   primitive in §2: key derivation, commitment hashes, nullifiers, note encrypt/decrypt
   round-trips, merkle roots for known leaf sequences, `TransactionStructV2` serialization for
   each shape, boundParams hashes, and **spend-authorization message construction +
   EdDSA sign/verify vectors** (this closes, byte-level, the open question of whether
   `armada-circuits` consume the identical EdDSA-Poseidon encoding — currently supported only
   by the indirect evidence that stock-engine proofs verify against our verifier).

*Acceptance:* vectors captured in the POC repo (which keeps the capture scripts) and committed
to the `armada-sdk` repo under `test/vectors/`, stamped with the engine version they were
captured from; spike findings recorded in this spec (amend §4.2 / open decision 6).

### Phase 1 — Repo bootstrap + pinned core at parity

1. Bootstrap the `ship-armada/armada-sdk` repo: MIT LICENSE + NOTICE.md, this spec as
   `SPEC.md`, strict tsconfig, vitest, browser/node build, branch protection + PR-only from
   day one, CI running lint/unit/vectors.
2. Vendor engine sources at `v9.6.0` for the §2 primitives into `vendor/railgun-engine/`
   (tag↔npm verification per §3.4; PPOI stripped per §3.5); adapt into `core/` with no
   Node-builtin leakage.
3. Differential runner: every Phase 0 vector green against `core/`.
4. CI job running the vector suite on every PR.

*Acceptance:* 100% vector parity; `core/` importable in a browser bundle without polyfills
beyond snarkjs's own needs; no `@railgun-community/*` imports anywhere in the repo;
`rg "POI" src/ vendor/` returns nothing (§3.5).

### Phase 2 — Wallet layer replacement (the bulk)

Order within phase (each step integration-tested against local Anvil):

1. **storage/** — adapters, schema versioning + deployment binding, at-rest encryption.
2. **sync/** — event scan + bisecting fetch, merkle build w/ root verification, checkpoints,
   events. Validate: fresh scan of an existing local + Sepolia deployment reproduces balances
   the stock SDK reports (differential integration test).
3. **keys/enrollment/custody** — `fromRootSecret` (per Phase 0 findings), ephemeral in-memory
   wallets, recovery paths, `fromMnemonic` compat for the relayer; the `SpendSigner` interface
   with `LocalSigner` + an in-process `ExternalSigner` test double; view-only wallets
   (§4.2.2). The `ExternalSigner` *interface* is frozen at the end of this step (integrations
   build against it); no out-of-process transport or gating logic is implemented in the SDK.
4. **prover/** — worker adapters, artifact source + integrity manifest (generated by the
   `armada-circuits` build), progress events.
5. **tx/** — plan/ProofHandle pipeline, adaptParams encoders (CCTP #399, yield), wrapper
   calldata builders, decode API + `extractFeeOutput`, shield request builder, fee binding per
   FEE_STRUCTURE.md, preflight.
6. **Integration:** `lib/sdk/` gains an armada-sdk backend selected by env flag; the interface's
   `src/lib/railgun/` modules likewise. Relayer fee verification switches to the decode API.
   Existing test suites (`npm run test`, `test:all`) pass on both backends.

*Acceptance:* every §1.2 workaround owned by Phase 2 is deleted on the armada-sdk path; #399's
cross-chain unshield binding works end-to-end on local Anvil (extend
`scripts/capture/e2e-armada-circuits.ts` pattern); proof generation runs off-main-thread in the
interface with live progress; kill-the-tab-mid-scan leaves no plaintext note data at rest;
**headless integrator profile** — a Node-only e2e (no browser APIs) covering shield → transfer
→ unshield through an `ExternalSigner` test double, plus balance reconciliation through a
view-only wallet; `rg -i "salt|paros" src/` in the armada-sdk repo returns nothing. POC-side
integration consumes a pinned prerelease build of the SDK (§3.1), with the consumed version
recorded in each integration PR.

### Phase 3 — Payments layer + claimable payments

1. Shared versioned encoding infra; payment requests (§5.1); `note:received` events (§5.2).
2. Claim-seed derivation + counter discipline (§6.2) with its full test battery (vectors,
   property tests, crash-recovery, multi-installation).
3. Claim envelope + ECIES suite + pubkey resolver (§6.3).
4. `importNote` (§6.4) + ephemeral claim/reclaim flows (§6.5) e2e on local Anvil: create →
   envelope → independent claim; create → sweep; claim/revoke race (both orders).
5. Pending-claims ledger + sweep scheduler on the ops journal (§6.6).
6. Receipts (§5.3) after resolving open decision 1.

*Acceptance:* full cheque lifecycle e2e green including the race; zero seed persistence
verified by storage inspection in tests; bare-link caps enforced.

### Phase 4 — Ops journal (full) + observability

1. Cross-chain lifecycle state machine + resume, mock CCTP locally, Iris polling for Sepolia.
2. Journal-driven progress in the interface; relayer consumes the same module where useful.
3. Telemetry sink wiring (Sentry, relayer monitoring), error-code audit across the SDK.

*Acceptance:* kill-and-restart mid-cross-chain-transfer resumes and completes on local; no
string-matched errors remain in interface/relayer code touching the SDK.

### Phase 5 — Cutover and shrink

1. Default all surfaces to armada-sdk; soak; then remove `@railgun-community/*` dependencies,
   the `--legacy-peer-deps` requirement (verify no other dep needs it), dead adapter code in
   `lib/sdk/` and `src/lib/railgun/`, and the Vite polyfill scaffolding no longer needed.
2. Documentation upkeep pass: CLAUDE.md (pitfalls that no longer exist: stale railgun-db,
   legacy-peer-deps, LevelDB paths), ARCHITECTURE_NOTES, relayer README, this spec's status.

*Acceptance:* `rg "@railgun-community" --glob '!_legacy/**' --glob '!node_modules/**'` returns
nothing; fresh-clone install without `--legacy-peer-deps`; all suites green.

### 10.1 Risk register

| Risk | Sev | Mitigation |
|---|---|---|
| Divergence in pinned core (fund/privacy loss class) | Critical | Vector suite as permanent CI gate; vendored source not rewrite; Phase 1 parity gate before any product work |
| Claim-seed nonce reuse (fund loss) | Critical | §6.2 write-ahead counter, property tests, per-installation salt; spec'd uniqueness argument |
| `fromRootSecret` breaks existing wallet identities | High | Phase 0 spike + vectors; open decision 6 fallback keeps identity byte-stable |
| `importNote` interacts badly with UTXO selection edge cases | High | Dedicated integration tests incl. stale locator, spent note, lagging tree; ship behind claim feature only |
| Worker prover env matrix (Vite, jsdom, Node versions) | Medium | Same-thread fallback; e2e in real browser via existing interface test tooling |
| At-rest encryption perf on large TXO sets | Medium | Encrypt per-record not per-store; benchmark in Phase 2 with synthetic 10k-note wallet |
| Scope creep into circuits/contracts | Medium | §1.3 constraints; any contract/circuit change proposal must exit this project and go through normal governance/spec process |
| Integration code (Salt/Paros policy, transports) leaking into the SDK | Medium | §4.2.1 boundary: SDK ships interface + `LocalSigner` + test double only; connector implementations live in the integration layer; Phase 2 acceptance greps for it |

### 10.2 Testing strategy (summary)

- **Differential vectors** (Phase 0/1) — pinned-core parity, run in CI forever.
- **Unit** — per module; crypto modules additionally property-tested (fast-check) for
  derivation uniqueness, encode/decode round-trips, counter monotonicity.
- **Integration** — local Anvil chains (`npm run chains` + `npm run setup`), both SDK backends
  during Phases 2–4; relayer fee verification against real proofs.
- **e2e** — extend the `scripts/capture/e2e-armada-circuits.ts` pattern: shield → transfer →
  unshield → cross-chain → claim lifecycle, testing mode OFF (real Groth16 on-chain verify).
- **Fund-safety suites** are named and non-optional: nonce uniqueness (§6.2), nullifier race
  (§6.5), storage-reset-preserves-identity (§4.3).

---

## 11. Handoff notes for the implementing agent

- Read first: this spec; `specs/TX_SIGNING.md` + `TX_SIGNING_V2_AMENDMENT.md`;
  `specs/FEE_STRUCTURE.md`; `.claude/ARCHITECTURE_NOTES.md`; PR #373; issue #399. For the
  external-signer/view-only requirements' downstream consumer, `specs/PAROS_INTEGRATION.md`.
- Stock SDK source for vendoring: the upstream `Railgun-Community/engine` GitHub repo at tag
  `v9.6.0` (TypeScript sources; the npm package ships compiled dist only), with the tag↔npm
  verification of §3.4. The locally installed
  `node_modules/@railgun-community/{engine,wallet,shared-models}` (after the Phase 0 upstream
  refresh) is the runtime ground truth to compare against. The `wallet` package is replaced,
  not vendored — read it for reference only.
- Current integration surfaces to study before Phase 2: `lib/sdk/*` (Node),
  `apps/armada-interface/src/lib/railgun/*` (browser), `relayer/modules/railgun-wallet.ts` +
  `broadcaster-fee-verifier.ts` (relayer).
- The known repo pitfalls apply during development: Anvil chains must be running for
  integration tests; delete `data/railgun-db/` if stock-SDK-path tests behave strangely after
  redeploys (the very pitfall Phase 2 removes).
- Work in feature branches per repo git policy; never commit without explicit instruction;
  flag any PR touching `relayer/` or `config/*.env` for VPS redeploy.

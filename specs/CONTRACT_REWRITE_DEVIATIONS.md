# Contract Implementation — Deviation Register

**Companion to:** `specs/PRIVACY_POOL_CONTRACT.md` (behavior specification)
**Purpose:** The canonical register of intentional behavioral deviations between the
behavior spec and the new implementation. Provenance details for consensus-critical
constants are maintained in a private appendix (kept outside the public repo).


## A. Consensus-critical constants

| ID | Item | Fact | Handling |
|---|---|---|---|
| C-1 | `ZERO_VALUE` | The Merkle tree's level-0 zero leaf is defined in the legacy implementation as a hash-derived SNARK field element (exact derivation recorded in the private appendix). Its **value** — `0x0488f89b25bc7011eaf6a5edce71aeafb9fe706faa3c0a5cd9cbe868ae3b9ffc` (decimal `2051258411002736885948763699317990061539314419500486054347250703186609807356`) — is a consensus fact: every empty node, the initial root, and all root-history entries derive from it. | Hard-code the numeric literal. Do **not** reproduce the derivation expression or the seed string anywhere in source or comments. |
| P-2 | Core event shapes | `Shield`, `Transact`, `Unshield`, `Nullified` event signatures (topic0 values listed in the main spec §11) are byte-identical to the legacy events; off-chain SDK log scanning depends on them. | Preserve exactly. |
| C-2 | Type layouts | All structs/enums in main-spec §3 are ABI-pinned to the legacy encoding (calldata, `boundParamsHash`, event data). | Preserve field names/types/order exactly; rewrite all documentation prose. |

---

## B. Deviation register (intentional differences from the legacy implementation)

| ID | Area | Legacy behavior | Armada behavior | Status |
|---|---|---|---|---|
| D-1 | Zero-value constant | Derived inline from a protocol-name seed string. | Same **value**, hard-coded; seed string confined to provenance row P-1. | Settled (P-1). |
| D-2 | Unshield fee | Legacy charged a configurable unshield fee (capped at 50%) and emitted it in `Unshield`. | Unshields are free; `unshieldFee` storage slot retained at 0 for layout compatibility; the `Unshield` event keeps its 4-field shape with `fee = 0` for log-parser compatibility. | Settled per `specs/FEE_STRUCTURE.md`. |
| D-3 | Proof bypass | No testing bypass existed. | `testingMode` flag (owner-set) bypasses SNARK verification entirely; POC-only, **must not ship to production**. Removal tracked as main-spec **OQ-11**. | Temporary — removal planned. |
| D-4 | Unshield recipient hook | Legacy POC tree contained an `IUnshieldCallback` hook invoked on contract recipients during unshield. | **Dropped.** TransactModule performs a plain ERC20 transfer; no callback is attempted. | Settled (intentional removal). |
| D-5 | NFT support | Legacy executed ERC721/ERC1155 shields and unshields with token-ID mapping and a flat NFT fee. | Execution paths accept **ERC20 only** (`"ShieldModule: Only ERC20 supported"` / `"TransactModule: Only ERC20 supported"`). NFT types, `tokenIDMapping`, `nftFee`, and the ERC721 validation branch remain as inert ABI/storage artifacts (main-spec **OQ-6**). | Settled for current scope. |
| D-6 | Fee architecture | Single flat shield fee with a `FeeChange` admin event. | Pluggable fee module (`feeModule`, integrator splits, volume tiers per `specs/FEE_STRUCTURE.md`) with flat-fee fallback; `setShieldFee` emits no event and is capped at 10% (`MAX_SHIELD_FEE_BPS = 1000`, post-drift upstream fix — OQ-10 RESOLVED); privileged-caller fee exemption added. | Settled design. |
| D-7 | Verification-key registry | Legacy verifier used additional safety-vector gating around key/vector management. | Bare owner-set mapping keyed by circuit shape `(nullifiers, commitments)`; "set" iff `alpha1.x != 0`; `snarkSafetyVector` storage retained but never used (main-spec **OQ-12**). | Settled for current scope. |
| D-8 | Gas-estimation bypass | Legacy exposed a verification bypass for a designated `tx.origin` (`0x…dEaD`). | Behavior retained verbatim, including its late placement (after VK check and pairing compute) — main-spec **OQ-4** questions whether to keep it. | Open (OQ-4). |
| D-9 | Architecture | Legacy was a monolithic logic contract behind a proxy. | Router + `delegatecall` modules sharing one frozen storage layout; modules are non-upgradeable after `initialize`. | Settled (Armada architecture). |
| D-10 | Cross-chain | Not present. | CCTP V2 integration: hook handlers, `atomicCrossChainUnshield`, `CrossChainUnshieldInitiated`/`RemotePoolSet`/`DefaultFinalityThresholdSet` events, remote-pool registry. | Armada extension. |
| D-11 | Pause / wind-down | Not present. | `shieldPauseContract` hook: shields pausable; withdraw-only mode blocks pure transfers; 24h non-renewable emergency pause blocks everything including unshields. | Armada extension (governance). |
| D-12 | Admin surface | Legacy had `changeFee`, treasury rotation, vector-list admin. | Armada admin set: remote pools, VKs, shield fee, testing mode, privileged callers, hook router, finality threshold, pause contract, fee module. No ownership transfer; treasury fixed at init. | Settled for current scope. |
| D-13 | Gas envelope (Phase 2) | — | Pre-drift-port replay of the v1 corpus showed the new modules uniformly **cheaper** (gas deltas 0 on admin/config vectors and −32…−353 on shield/transact/unshield vectors). After porting the post-drift fixes (D-15..D-18), unchanged v1 paths replay at +0..+2,624 — the delta is the `nonReentrant` guard's storage writes (D-18), not the new implementation. | Settled (gas-only). |
| D-14 | Replay harness time-dependence | — | The `shield-gasless-wrapper` vector carries an EIP-2612 permit with deadline = capture block.timestamp + 1h. Replay requires a fixturenet booted with `anvil --timestamp <manifest.generatedAt>`; `replay-check.ts` fails fast with the exact command when the chain clock is outside the capture window. Harness-only constraint, not a contract difference. | Settled (harness). |

### Post-drift reconciliation (2026-09-30 — main absorbed M0-era fixes after the original corpus was captured)

The rewrite was rebased onto current main and the post-drift behavioral fixes were ported into the new modules as deliberate design (all changes are Armada-original commits on main — no provenance concern). The original 71-vector corpus remains the pre-drift differential; a second corpus (`test-foundry/fixtures/contract-vectors-v2/`, captured from main's deployed behavior) is the post-drift differential gate.

| ID | Area | Pre-drift Armada behavior (v1 corpus) | Current behavior (v2 corpus, the new implementation) | Status |
|---|---|---|---|---|
| D-15 | Cross-chain shield-in | Single-note `processIncomingShield(amount, ShieldData)`; one Shield event per note. | Multi-note `processIncomingShield(amount, ShieldData[])`: index 0 is the recipient (absorbs CCTP protocol fee), later notes (e.g. relayer fee notes) mint at full declared value; ALL notes batch-insert with a SINGLE Shield event (same shape as local `shield`). | Settled (ported). |
| D-16 | Cross-chain unshield hardening | Caller-supplied `destinationCaller` (bytes32(0) = any relayer could strand funds); destination tuple not proof-bound. | `destinationCaller` pinned on-chain to `remoteHookRouters[domain]` (owner-set, revert if unset); `(recipient, domain, maxFee)` bound into the proof via `boundParams.adaptParams = CCTPBindingLib.encode(...)` (no circuit change — adaptParams is already a public input); `adaptContract` must be zero on this path; caller-supplied `uniqueNonce` echoed into hookData for off-chain delivery matching; USDC allowance zero-reset before approve (OZ 4.9 safeApprove quirk). | Settled (ported). |
| D-17 | Verification placement | `verify` duplicated: live copy on the router + a dead module copy (OQ-2). | Verification centralized on the router (`PrivacyPool.verify`); the module's `verify` reverts ("verify handled by PrivacyPool router"). Behavior identical; kills the drift risk of two copies. OQ-2 RESOLVED. | Settled (ported). |
| D-18 | Router hardening | `initialize()` callable by anyone once (front-runnable — OQ-7); no reentrancy guard; owner-set `privilegedShieldCallers` fee exemption; no token blocklist admin on the router; local unshield to the pool address possible (cross-path replay: an xchain-unshield proof pays the pool; replaying it via `transact()` would strand funds pool→pool). | `initialize()` gated to the deployer (OQ-7 RESOLVED); `nonReentrant` on `shield`/`transact`/`atomicCrossChainUnshield` (status slot in shared storage); fee exemption derived from the timelock-governed `adapterRegistry` (set-once, `authorized OR withdraw-only`) — `privilegedShieldCallers` retired to an inert slot; `addToBlocklist`/`removeFromBlocklist` admin with USDC unblockable; `setAdapterRegistry`/`setRemoteHookRouter` admin added; `_transferTokenOut` rejects pool-address recipients. Storage gap 46→43. | Settled (ported). |

---

## C. Naming hygiene rules for the new implementation

1. The string from provenance row P-1 must not appear in any rewritten file (source, comments, tests, docs) outside this register. Reviewers should grep for it.
2. Struct/field/event names in main-spec §3/§11 are ABI constraints, not copied prose; keep identifiers, write all comments fresh.
3. Where the legacy implementation is referenced in discussion, use "the legacy implementation"; the legacy protocol's name may appear only in Sections A and B above.

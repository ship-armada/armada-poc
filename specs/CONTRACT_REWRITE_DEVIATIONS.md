# Contract Rewrite — Deviation & Provenance Register

**Companion to:** `specs/PRIVACY_POOL_CONTRACT.md` (Phase 0 clean-room rewrite spec)
**Purpose:** This is the *only* document in the contract-rewrite workspace where the
legacy upstream system may be named, and the canonical register of (a) intentional
behavioral deviations from the legacy implementation and (b) provenance notes for
consensus-critical constants whose derivation involves legacy identifiers.

> **Legal note.** The rewrite engineer works exclusively from
> `specs/PRIVACY_POOL_CONTRACT.md`. This register exists so the team (and auditors)
> can track where the new system deliberately diverges from, or is pinned to,
> legacy behavior. Nothing here grants permission to consult unlicensed source.

---

## A. Provenance register (consensus-critical constants)

| ID | Item | Fact | Handling in rewrite |
|---|---|---|---|
| P-1 | `ZERO_VALUE` | The Merkle tree's level-0 zero leaf is defined in the legacy implementation as `bytes32(uint256(keccak256("Railgun")) % SNARK_SCALAR_FIELD)`. Its **value** — `0x0488f89b25bc7011eaf6a5edce71aeafb9fe706faa3c0a5cd9cbe868ae3b9ffc` (decimal `2051258411002736885948763699317990061539314419500486054347250703186609807356`) — is a consensus fact: every empty node, the initial root, and all root-history entries derive from it. | Hard-code the numeric literal. Do **not** reproduce the derivation expression or the seed string anywhere in rewritten source or comments ("naming hygiene"). The string appears only in this row of this file. |
| P-2 | Core event shapes | `Shield`, `Transact`, `Unshield`, `Nullified` event signatures (topic0 values listed in the main spec §11) are byte-identical to the legacy events; off-chain SDK log scanning depends on them. | Preserve exactly. |
| P-3 | Type layouts | All structs/enums in main-spec §3 are ABI-pinned to the legacy encoding (calldata, `boundParamsHash`, event data). | Preserve field names/types/order exactly; rewrite all documentation prose. |

---

## B. Deviation register (intentional differences from the legacy implementation)

| ID | Area | Legacy behavior | Armada behavior | Status |
|---|---|---|---|---|
| D-1 | Zero-value constant | Derived inline from a protocol-name seed string. | Same **value**, hard-coded; seed string confined to provenance row P-1. | Settled (P-1). |
| D-2 | Unshield fee | Legacy charged a configurable unshield fee (capped at 50%) and emitted it in `Unshield`. | Unshields are free; `unshieldFee` storage slot retained at 0 for layout compatibility; the `Unshield` event keeps its 4-field shape with `fee = 0` for log-parser compatibility. | Settled per `specs/FEE_STRUCTURE.md`. |
| D-3 | Proof bypass | No testing bypass existed. | `testingMode` flag (owner-set) bypasses SNARK verification entirely; POC-only, **must not ship to production**. Removal tracked as main-spec **OQ-11**. | Temporary — removal planned. |
| D-4 | Unshield recipient hook | Legacy POC tree contained an `IUnshieldCallback` hook (`onRailgunUnshield`) invoked on contract recipients during unshield. | **Dropped.** TransactModule performs a plain ERC20 transfer; no callback is attempted. | Settled (intentional removal). |
| D-5 | NFT support | Legacy executed ERC721/ERC1155 shields and unshields with token-ID mapping and a flat NFT fee. | Execution paths accept **ERC20 only** (`"ShieldModule: Only ERC20 supported"` / `"TransactModule: Only ERC20 supported"`). NFT types, `tokenIDMapping`, `nftFee`, and the ERC721 validation branch remain as inert ABI/storage artifacts (main-spec **OQ-6**). | Settled for current scope. |
| D-6 | Fee architecture | Single flat shield fee with a `FeeChange` admin event. | Pluggable fee module (`feeModule`, integrator splits, volume tiers per `specs/FEE_STRUCTURE.md`) with flat-fee fallback; `setShieldFee` emits no event and is capped at 100% (main-spec **OQ-10**); privileged-caller fee exemption added. | Settled design; cap open (OQ-10). |
| D-7 | Verification-key registry | Legacy verifier used additional safety-vector gating around key/vector management. | Bare owner-set mapping keyed by circuit shape `(nullifiers, commitments)`; "set" iff `alpha1.x != 0`; `snarkSafetyVector` storage retained but never used (main-spec **OQ-12**). | Settled for current scope. |
| D-8 | Gas-estimation bypass | Legacy exposed a verification bypass for a designated `tx.origin` (`0x…dEaD`). | Behavior retained verbatim, including its late placement (after VK check and pairing compute) — main-spec **OQ-4** questions whether to keep it. | Open (OQ-4). |
| D-9 | Architecture | Legacy was a monolithic logic contract behind a proxy. | Router + `delegatecall` modules sharing one frozen storage layout; modules are non-upgradeable after `initialize`. | Settled (Armada architecture). |
| D-10 | Cross-chain | Not present. | CCTP V2 integration: hook handlers, `atomicCrossChainUnshield`, `CrossChainUnshieldInitiated`/`RemotePoolSet`/`DefaultFinalityThresholdSet` events, remote-pool registry. | Armada extension. |
| D-11 | Pause / wind-down | Not present. | `shieldPauseContract` hook: shields pausable; withdraw-only mode blocks pure transfers; 24h non-renewable emergency pause blocks everything including unshields. | Armada extension (governance). |
| D-12 | Admin surface | Legacy had `changeFee`, treasury rotation, vector-list admin. | Armada admin set: remote pools, VKs, shield fee, testing mode, privileged callers, hook router, finality threshold, pause contract, fee module. No ownership transfer; treasury fixed at init. | Settled for current scope. |
| D-13 | Gas envelope (Phase 2 rewrite) | — | The rewritten modules are uniformly **cheaper**: 71/71 golden-vector replay shows gas deltas of 0 on admin/config vectors and −32…−353 on shield/transact/unshield vectors (root cause not yet attributed — candidate: the Poseidon stub/library-link change altering call-site codegen; events, state diffs, and revert reasons are byte-identical, so this is gas-only). | Settled (favorable, report-only). |
| D-14 | Replay harness time-dependence | — | The `shield-gasless-wrapper` vector carries an EIP-2612 permit with deadline = capture block.timestamp + 1h. Replay requires a fixturenet booted with `anvil --timestamp <manifest.generatedAt>`; `replay-check.ts` fails fast with the exact command when the chain clock is outside the capture window. Harness-only constraint, not a contract difference. | Settled (harness). |

---

## C. Naming hygiene rules for the rewrite

1. The string from provenance row P-1 must not appear in any rewritten file (source, comments, tests, docs) outside this register. Reviewers should grep for it.
2. Struct/field/event names in main-spec §3/§11 are ABI constraints, not copied prose; keep identifiers, rewrite all comments.
3. Where the legacy implementation is referenced in discussion, use "the legacy implementation"; the legacy protocol's name may appear only in Sections A and B above.

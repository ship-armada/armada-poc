# Armada Crowdfund — Audit Handoff Package Definition

## Purpose

Define the exact contents, evidence requirements, and acceptance criteria for handing the Armada crowdfund implementation to auditors. This document is the manifest for the audit package itself — it says what must be in the box, what must be proven before the box ships, and how to resolve conflicts between documents.

**The implementation is not audit-ready until every section of this document is satisfied.**

---

## 1. Canonical Sources — Priority Order

If two documents ever conflict, the higher-numbered document loses. This hierarchy is absolute.

| Priority | Document | Controls | Notes |
|---|---|---|---|
| **1 (highest)** | `CROWDFUND.md` | Mechanism, state machine, contract interface, allocation logic, settlement model, event semantics | The spec. Everything implements from this. |
| **2** | `PARAMETER_MANIFEST.md` | Every concrete deployment value — addresses, timestamps, constants, decimal encodings, gas benchmarks | The numbers. For concrete deployment values (addresses, timestamps, decimal-encoded constants), this document takes precedence over human-readable values in CROWDFUND.md. For mechanism rules and behavioral specifications, CROWDFUND.md takes precedence. |
| **3** | `IMPLEMENTATION_TEST.md` | Test plan, invariants, scenario matrix, fuzz axes, event correctness, exit criteria | The verification surface. All tests derive from CROWDFUND.md. |
| **4** | `OPERATIONS.md` | Deployment sequence, operator procedures, failure runbook, decision logs | The operational layer. Procedures must be consistent with CROWDFUND.md but do not override it. |
| **5** | `MONITORING.md` | Alert rules, derived state model, threshold-based signals, dashboard requirements | The observability layer. Alerts derive from CROWDFUND.md's event model. |
| **6** | `CROWDFUND_OBSERVER.md` | Event-consumed read model, per-hop display, graph construction | UI spec. Defines what the observer needs from the contract event surface. Does not constrain contract behavior beyond event emissions. |
| **7** | `CROWDFUND_COMMITTER.md` | Wallet-connected UI, invite link flow, claim flow, eligibility display | UI spec. Same constraint as observer — consumes the contract surface, does not define it. |
| **8** | `CROWDFUND_REVIEW_BRIEF.md` | Reviewer orientation, known historical bugs, pressure-test scenarios | Review aid. Not authoritative — it summarizes CROWDFUND.md for fresh readers. |

**Excluded from the audit package:**
- `CROWDFUND_ADDITIONS.md` — historical staging document. All content merged into CROWDFUND.md. Retained in repo for review history only. Do not reference for implementation.

---

## 2. Required Code Artifacts

The following must exist in the repository before audit handoff.

### 2.1 Contracts

| Artifact | Description | Traces to |
|---|---|---|
| `ArmadaCrowdfund.sol` | Core crowdfund contract — external functions per CROWDFUND.md §Contract Interface, including `computeAllocation()` view function | CROWDFUND.md §Contract Interface |
| Lazy settlement architecture | `finalize()` writes aggregate state only (zero per-participant storage). `claim()` computes allocation on-the-fly via `computeAllocation()`. No `emitSettlement()`. | CROWDFUND.md §Finalization, §Gas Considerations |
| EIP-712 invite signature verification | `commitWithInvite()` with `SignatureChecker.isValidSignatureNow()` (EOA + EIP-1271) | CROWDFUND.md §EIP-712 Typed Data |

### 2.2 Interfaces

| Artifact | Description |
|---|---|
| `IArmadaCrowdfund.sol` | External interface — all public/external function signatures |
| Event definitions | All 12 events per CROWDFUND.md §Required Contract Events |

### 2.3 Deployment

| Artifact | Description | Traces to |
|---|---|---|
| Deploy script | Parameterized from PARAMETER_MANIFEST.md values | PARAMETER_MANIFEST.md; OPERATIONS.md §3 |
| Constructor args file | Exact values from PARAMETER_MANIFEST.md, verified | PARAMETER_MANIFEST.md §14 Freeze Checklist |

### 2.4 Test suite

| Artifact | Description | Traces to |
|---|---|---|
| `Crowdfund.t.sol` | Per-function unit tests (§5 of test spec) | IMPLEMENTATION_TEST.md §5 |
| `CrowdfundScenarios.t.sol` | Deterministic scenario fixtures S1–S19 | IMPLEMENTATION_TEST.md §6 |
| `CrowdfundInvariants.t.sol` | Invariant / fuzz harness (invariants 4.1–4.12) | IMPLEMENTATION_TEST.md §4, §7 |
| `CrowdfundEvents.t.sol` | Event correctness and ordering tests | IMPLEMENTATION_TEST.md §8 |
| `CrowdfundUiSurface.t.sol` | Observer / committer compatibility tests | IMPLEMENTATION_TEST.md §9 |
| `CrowdfundGas.t.sol` | Gas measurement fixtures (S16: max network) | IMPLEMENTATION_TEST.md §6 S16 |

### 2.5 Documentation artifacts

| Artifact | Description | Package path |
|---|---|---|
| `SPEC_TRACEABILITY.md` | Mapping from every major rule in CROWDFUND.md to one or more tests. Every rule must appear. Any unmapped rule is a visible gap. | `SPEC_TRACEABILITY.md` (root) |
| ABI JSON | Exported ABI for the deployed contract | `deploy/ArmadaCrowdfund.abi.json` |
| Gas report | Output from `forge test --gas-report` or equivalent, including S16 max-network fixture | `GAS_REPORT.md` (root) |

---

## 3. Required Evidence

Ian must produce the following before handoff. Each item has a pass/fail criterion.

### 3.1 Test results

| Evidence | Pass criterion |
|---|---|
| All per-function happy-path tests | Green |
| All revert tests | Green |
| All deterministic scenarios S1–S19 | Green |
| All global invariants under fuzzing (4.1–4.12) | No invariant break after minimum 10,000 fuzz runs |
| `computeAllocation()` / `claim()` equivalence (4.12) | For all participants, view function output matches actual claim output |
| All event correctness tests | Green, including claim-time ordering guarantees |
| Observer and committer compatibility tests | Green |

### 3.2 Gas measurements

| Evidence | Pass criterion |
|---|---|
| S16 max-network `finalize()` gas | Measured and recorded. Expected 3-5M under lazy settlement (aggregate-only). |
| `claim()` gas per participant | Measured. Expected ~200k. |
| `computeAllocation()` gas (view) | Measured. Should be negligible. |
| Slot-count model confirmed | `slotCount[address][hop]` is a counter, not a boolean. Required for `computeAllocation()` correctness. |
| Per-function gas report | Generated and included in package |

### 3.3 Spec traceability

| Evidence | Pass criterion |
|---|---|
| `SPEC_TRACEABILITY.md` complete | Every external function in CROWDFUND.md §Contract Interface maps to ≥1 test |
| Every event in CROWDFUND.md §Required Contract Events maps to ≥1 test | |
| Every invariant in IMPLEMENTATION_TEST.md §4 maps to ≥1 test | |
| Every scenario in IMPLEMENTATION_TEST.md §6 maps to ≥1 test fixture | |
| No rule in CROWDFUND.md is unmapped | |

### 3.4 Deployment dry run

**Required for audit handoff (contract-level verification):**

| Evidence | Pass criterion |
|---|---|
| Deploy script executed on testnet | Successful deployment with correct constructor args |
| PARAMETER_MANIFEST.md §11 deployment record filled (testnet) | All fields populated |
| OPERATIONS.md §3 Steps 1–5 executed on testnet | Deploy, verify source, verify DOMAIN_SEPARATOR, transfer ARM, loadArm — all confirmed |
| `DOMAIN_SEPARATOR()` verified on testnet deployment | Matches locally computed value |
| All events emittable on testnet | At minimum: `ArmLoaded`, `SeedAdded`, `Invited`, `Committed`, `Finalized` confirmed |

**Required before mainnet deployment (not blocking audit):**

| Evidence | Pass criterion |
|---|---|
| OPERATIONS.md §3 Steps 6–9 executed on testnet | Hop-0 additions, observer/committer verification, announcement flow |
| Observer loads events from testnet deployment | Correct graph and stats display |
| Committer wallet flow tested on testnet | Connect, commit, invite link, claim — all functional |

---

## 4. Intentional Properties (for auditors)

These are design choices that may look like bugs. They are deliberate and specified in CROWDFUND.md. Auditors should verify they work correctly, not flag them as issues.

| Property | Why it exists | Spec reference |
|---|---|---|
| **Multi-slot model** — each invite creates a new participation slot with real economic value (increased cap + outgoing invite rights) | Any per-address limit that can be bypassed with a second wallet should not exist. Multi-slot makes concentration legible rather than hidden. | CROWDFUND.md §Invitation Limits, §Self-Filling |
| **Same-address multi-hop** — one address can commit at hop-0, hop-1, and hop-2 simultaneously and receive ARM from all three | Transparency model. Same-address multi-hop creates unambiguous self-loops in the graph. | CROWDFUND.md §Self-Filling |
| **$33k single-entity capture** — a hop-0 participant can control a full subtree ($15k + 3×$4k + 6×$1k) via recursive self-invitation | This is the design ceiling, not a bug. It's 2.75% of the base raise. Bounded by real capital and graph visibility. | CROWDFUND.md §Self-Filling |
| **Duplicate same-hop invites are permitted** — same inviter can invite the same address to the same hop multiple times | Consistency: "allow everything, make it visible." Inviter's slot budget limits the scope. | CROWDFUND.md §Duplicate Invites |
| **`refundMode` is a defined outcome, not a failure** — occurs when capped_demand qualifies but net_proceeds falls short after allocation | Happens at base size when hop-0 is oversubscribed. Cannot happen after expansion. | CROWDFUND.md §Finalization step 5 |
| **Over-cap deposits are accepted, not reverted** — excess is refunded at settlement | Simpler UX. Participants don't need to calculate exact caps. | CROWDFUND.md §Commitment |
| **`commitWithInvite()` bundles invite + commit atomically** — invitee appears in graph only when they commit with funds | Prevents invite squatting (redeeming a slot without deploying capital). | CROWDFUND.md §Invite Mechanism Path A |
| **Zero-amount commits revert** — `amount > 0` enforced on both `commit()` and `commitWithInvite()` | Prevents free slot acquisition and graph noise without capital. | CROWDFUND.md §Contract Interface |
| **`addSeed()` reverts on duplicate address** — each address can hold at most one hop-0 slot | Duplicate hop-0 slots are a qualitatively different concentration path than the visible invite tree. | CROWDFUND.md §Contract Interface |
| **Nonce 0 reserved** — direct invites emit `nonce = 0`; link-based invites require `nonce > 0` | Sentinel value distinguishes invite paths in events. | CROWDFUND.md §EIP-712 Typed Data |
| **`claim()` boundary is inclusive (`<=`); sweep boundary is exclusive (`>`)** — at exactly the 3-year mark, claims are still permitted | Prevents off-by-one that locks out a last-second claimer. | CROWDFUND.md §Finalization, Claim deadline |
| **No admin-mutable parameters** — every value is immutable post-deployment | The mechanism is fully predeclared. No address can change any parameter after deployment. | PARAMETER_MANIFEST.md §12 |
| **`capped_demand` counts all hops independently** — an address at hop-0 and hop-1 contributes to both hop totals, with no primary-hop deduplication | This is the canonical demand variable for minimum raise, expansion trigger, and live stats. Multi-hop participation is real economic commitment at each hop and should be counted as such. | CROWDFUND.md §Allocation, §Commitment |

---

## 5. Known Assumptions

These are architectural decisions that constrain the implementation. They are not open questions — they are settled.

| Assumption | Implication |
|---|---|
| Lazy settlement architecture | `finalize()` writes aggregate state only (zero per-participant storage). `claim()` computes allocation on-the-fly via `computeAllocation()`. No `emitSettlement()`, no settlement mode selection. |
| `computeAllocation()` is canonical and pure | Same logic path as `claim()` minus side effects. Deterministic, order-independent. View function output must match actual claim output for all participants. |
| Slot-count model is a hard requirement | `slotCount[address][hop]` must be a counter that increments per invite. Cap math, self-fill analysis, `hopDemand`, and `computeAllocation()` all depend on this. If the contract models hop access as a boolean, the spec is incorrect. |
| Observer uses `computeAllocation()` for pre-claim display | Events alone are insufficient for pre-claim allocation display. Observer calls `computeAllocation(address)` after `Finalized` for theoretical allocations. `Allocated` events arrive incrementally at `claim()` time. |
| Committer assumes `claim()` is available immediately after `finalize()` | Theoretical allocations queryable via `computeAllocation()` immediately. No need to wait for events. |
| No backend in core protocol | Observer and committer are client-side, RPC-direct. No server-side indexer required. |
| The contract has no upgradability mechanism | No proxy, no UUPS, no diamond. The deployed bytecode is final. This is an implementation constraint — CROWDFUND.md says "Post-finalization, all privileged functions are permanently inactive" and PARAMETER_MANIFEST.md says "no admin-mutable parameters," which together imply non-upgradeability. Ian should confirm this is the implementation approach. |
| Claim event ordering is guaranteed | For each `claim()` call: `Allocated` before that participant's `AllocatedHop` events within the same transaction. |

---

## 6. Open Questions

**This section must be empty before audit handoff.**

If any item remains here, the implementation is not audit-ready.

| # | Question | Status | Resolution |
|---|---|---|---|
| | *(none)* | | |

---

## 7. Handoff Checklist

Final sign-off before sending the package to auditors.

| Check | Status | Owner |
|---|---|---|
| All code artifacts in §2 exist in repo | ☐ | Ian |
| All tests pass per §3.1 | ☐ | Ian |
| Gas measurements recorded per §3.2 (including `finalize()`, `claim()`, `computeAllocation()`) | ☐ | Ian |
| SPEC_TRACEABILITY.md complete per §3.3 | ☐ | Ian |
| Testnet deployment dry run passed per §3.4 | ☐ | Ian + Ops |
| PARAMETER_MANIFEST.md fully filled (no `[TBD]` fields) | ☐ | Gavin + Ops |
| Slot-count model confirmed in code | ☐ | Ian |
| `computeAllocation()` view function implemented and tested | ☐ | Ian |
| §6 Open Questions is empty | ☐ | Gavin |
| All 8 spec documents in `/outputs/` are the canonical versions (excluding CROWDFUND_ADDITIONS.md) | ☐ | Gavin |
| AUDIT_HANDOFF.md itself reviewed against current state of all docs (counts, references, paths) | ☐ | Gavin |
| Auditors have received: spec bundle + code + tests + gas report + traceability table | ☐ | Gavin |

---

## 8. Package Contents (what auditors receive)

```
armada-crowdfund-audit/
├── AUDIT_HANDOFF.md                    # This document — package manifest, priority hierarchy, intentional properties
├── spec/
│   ├── CROWDFUND.md                    # Canonical mechanism spec
│   ├── PARAMETER_MANIFEST.md           # Deployment values
│   ├── IMPLEMENTATION_TEST.md          # Test plan
│   ├── OPERATIONS.md                   # Deployment + ops runbook
│   ├── MONITORING.md                   # Alerting spec
│   ├── CROWDFUND_OBSERVER.md           # Observer UI spec (event surface)
│   ├── CROWDFUND_COMMITTER.md          # Committer UI spec (event surface)
│   └── CROWDFUND_REVIEW_BRIEF.md       # Reviewer orientation
├── contracts/
│   ├── ArmadaCrowdfund.sol             # Core contract
│   ├── IArmadaCrowdfund.sol            # Interface
│   └── [dependencies]                  # OpenZeppelin, etc.
├── test/
│   ├── Crowdfund.t.sol                 # Per-function tests
│   ├── CrowdfundScenarios.t.sol        # Scenario fixtures
│   ├── CrowdfundInvariants.t.sol       # Invariant / fuzz
│   ├── CrowdfundEvents.t.sol           # Event tests
│   ├── CrowdfundUiSurface.t.sol        # UI compatibility tests
│   └── CrowdfundGas.t.sol              # Gas fixtures
├── script/
│   └── Deploy.s.sol                    # Deployment script
├── deploy/
│   ├── constructor-args.json           # Exact values from PARAMETER_MANIFEST.md
│   └── ArmadaCrowdfund.abi.json        # Exported ABI
├── SPEC_TRACEABILITY.md                # Rule → test mapping
└── GAS_REPORT.md                       # Gas measurements
```

**What is NOT in the package:**
- `CROWDFUND_ADDITIONS.md` — historical only, excluded
- Frontend code — out of audit scope
- ARM token contract — separate audit scope (if applicable)
- Governance contracts — separate audit scope (see GOVERNANCE.md)

**Notable inclusions** (documents auditors may not expect):
- `PARAMETER_MANIFEST.md` — exact deployment values with decimal encodings; auditors should verify constructor args match this document
- `AUDIT_HANDOFF.md` — this document; the reading guide and priority hierarchy for the entire package

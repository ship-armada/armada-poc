# Contract Analysis Plan — Railgun CCTP POC

## Background and Motivation

The Railgun CCTP POC contains Solidity contracts for a privacy pool (ZK-based shielded pool), yield vault, governance, crowdfund, and CCTP bridging. A structured approach is needed to analyze these contracts for:

- **Correctness** — logic bugs, rounding, state machine violations
- **Security flaws** — reentrancy, access control, input validation
- **Exploits** — documented attack vectors and mitigations
- **Architecture** — best practices, upgradeability, centralization

The goal is a concrete, executable plan that the Executor can follow step-by-step, with clear success criteria for each task.

---

## Key Challenges and Analysis

### Contract Domains

| Domain | Contracts | High-Risk Areas |
|--------|-----------|-----------------|
| Privacy Pool | PrivacyPool, modules, RelayAdapt, Client | Nullifier reuse, proof verification, RelayAdapt trust |
| Yield | ArmadaYieldVault, ArmadaYieldAdapter, ArmadaTreasury | Share rounding, reentrancy in relay flow |
| Governance | ArmadaGovernor, VotingLocker, ArmadaTreasuryGov, TreasurySteward | Checkpoint logic, vote manipulation |
| Crowdfund | ArmadaCrowdfund | Unbounded `finalize()` loop, allocation rounding |
| CCTP | MockCCTPV2, MockUSDCV2, message handling | Message replay, domain validation |

### Known Concerns (from TESTING_NEXT_STEPS.md)

- `ArmadaCrowdfund.finalize()` — O(n) over participants, potential DoS at scale
- `ArmadaGovernor._checkProposalThreshold()` — `block.number - 1` (verify safety)
- `VotingLocker.unlock()` — CEI pattern and ReentrancyGuard coverage
- Batched finalization — not implemented; production may need it

---

## High-level Task Breakdown

### Phase 1: Static Analysis Setup and Execution

**Task 1.1 — Install and run Slither**
- Install: `pip install slither-analyzer`
- Run against: `contracts/privacy-pool/`, `contracts/yield/`, `contracts/governance/`, `contracts/crowdfund/`, `contracts/cctp/`
- Exclude: `lib/`, `node_modules/`, `_legacy/`
- **Success criteria:** Slither runs without crash; output saved to `reports/slither-report.md` (or similar)
- **Deliverable:** Triage findings (High/Medium/Low/Informational)

**Task 1.2 — Install and run Aderyn**
- Install: `cargo install aderyn`
- Run: `aderyn .` from project root
- **Success criteria:** Aderyn runs; output saved to `reports/aderyn-report.md`
- **Deliverable:** Triage findings

**Task 1.3 — Document static analysis results**
- Create `reports/static-analysis-summary.md` with:
  - Summary of High/Medium findings per contract
  - Action items (fix vs accept risk vs false positive)
- **Success criteria:** All High/Medium findings have a documented decision

---

### Phase 2: Domain-Specific Threat Modeling

**Task 2.1 — Privacy pool threat model**
- Document threats: nullifier reuse, Merkle inconsistency, proof bypass, RelayAdapt abuse, CCTP replay
- Map each threat to existing tests or gaps
- **Success criteria:** `reports/threat-model-privacy-pool.md` with threat table and coverage matrix

**Task 2.2 — Yield & RelayAdapt threat model**
- Document threats: share inflation, reentrancy in relay, fee manipulation, adapter privilege
- **Success criteria:** `reports/threat-model-yield.md`

**Task 2.3 — Governance & crowdfund threat model**
- Document threats: vote manipulation, allocation rounding, phase violations, reentrancy
- **Success criteria:** `reports/threat-model-governance-crowdfund.md`

---

### Phase 3: Invariant and Fuzz Test Expansion

**Task 3.1 — Privacy pool invariants**
- Add/verify invariants: fee conservation, Merkle root history, nullifier uniqueness
- Extend `PrivacyPoolInvariant.t.sol` or equivalent if gaps exist
- **Success criteria:** `forge test --match-path test-foundry/PrivacyPoolInvariant.t.sol` passes; invariants documented

**Task 3.2 — Yield vault invariants**
- Add invariant tests for: `totalAssets` consistency, share/value relationship, no share inflation
- **Success criteria:** New `YieldInvariant.t.sol` (or similar) passes; invariants documented

**Task 3.3 — Crowdfund invariants**
- Verify/extend: `sum(allocations) <= totalAllocated`, `allocUsdc + refund == committed`, phase monotonicity
- **Success criteria:** `CrowdfundInvariant.t.sol` passes; invariants documented

**Task 3.4 — Governance invariants**
- Verify/extend: vote tally consistency, no double voting, checkpoint monotonicity
- **Success criteria:** `VotingLockerInvariant.t.sol` passes; invariants documented

**Task 3.5 — Fuzz target expansion**
- Add fuzz tests for: amounts (0, 1 wei, max), addresses (zero, self), fee basis points
- **Success criteria:** Fuzz runs complete without discovered bugs; coverage documented

---

### Phase 4: Formal Verification (Halmos)

**Task 4.1 — Crowdfund allocation math**
- Add Halmos test: `allocUsdc + refund == committed` for all valid inputs
- Add: `allocUsdc <= committed`, `allocUsdc <= reserve`
- **Success criteria:** `halmos check` proves properties for allocation logic

**Task 4.2 — VotingLocker checkpoint correctness**
- Add Halmos test: `getPastLockedBalance` returns correct value for arbitrary checkpoint arrays
- **Success criteria:** Symbolic proof passes

**Task 4.3 — Merkle module consistency**
- Add Halmos test for insertion/root update consistency (if feasible with current Halmos setup)
- **Success criteria:** Document result (proven or limitations)

---

### Phase 5: Manual Review Checklist

**Task 5.1 — Correctness checklist**
- Walk each contract: overflow, division-by-zero, rounding, state machine
- **Success criteria:** `reports/manual-review-correctness.md` with per-contract notes

**Task 5.2 — Security checklist**
- Walk each contract: reentrancy, access control, input validation, oracle risk
- **Success criteria:** `reports/manual-review-security.md`

**Task 5.3 — Architecture checklist**
- Walk each contract: upgradeability, proxy safety, trust assumptions, centralization
- **Success criteria:** `reports/manual-review-architecture.md`

---

### Phase 6: Integration and Cross-Contract Analysis

**Task 6.1 — End-to-end flow tests**
- Document and run: Shield → Transfer → Unshield; Shielded lend → withdraw; Crowdfund → claim → lock → vote
- **Success criteria:** All flows pass; gaps documented

**Task 6.2 — Cross-contract invariants**
- Document: token balance consistency across PrivacyPool, vault, treasury; ARM supply consistency
- **Success criteria:** `reports/cross-contract-invariants.md` with test coverage

**Task 6.3 — Final report**
- Compile: static analysis, threat models, invariant coverage, formal proofs, manual review, integration
- **Success criteria:** `reports/CONTRACT_ANALYSIS_REPORT.md` — executive summary and findings

---

## Project Status Board

- [x] Crowdfund UI header polish: align observer/committer header with design reference (rounded inset header, border-aligned active nav, wallet button icon, balanced typography)
- [x] Task 1.1: Slither installed and run — report saved to `reports/slither-report.txt`, `reports/slither-report.json`
- [ ] Task 1.2: Aderyn (skipped — Rust not configured)
- [x] Task 1.3: Static analysis summary — `reports/static-analysis-summary.md`
- [x] Phase 2: Threat modeling (Tasks 2.1–2.3)
  - [x] Task 2.1: `reports/threat-model-privacy-pool.md`
  - [x] Task 2.2: `reports/threat-model-yield.md`
  - [x] Task 2.3: `reports/threat-model-governance-crowdfund.md`
- [x] Phase 3: Invariant/fuzz expansion (Tasks 3.1–3.5)
  - [x] Task 3.1: Privacy pool invariants verified (MerkleHandler, fee conservation)
  - [x] Task 3.2: Yield vault invariants — new `YieldInvariant.t.sol` (4 invariants)
  - [x] Task 3.3: Crowdfund invariants verified
  - [x] Task 3.4: Governance invariants verified (VotingLocker)
  - [x] Task 3.5: Boundary fuzz — new `BoundaryFuzz.t.sol` (1 wei, max, fee boundaries)
- [ ] Phase 2: Threat modeling (Tasks 2.1–2.3)
- [ ] Phase 3: Invariant/fuzz expansion (Tasks 3.1–3.5)
- [x] Phase 4: Formal verification (Tasks 4.1–4.3)
  - [x] Task 4.1: Crowdfund allocation — 4 provable properties proven; 3 SMT-undecidable covered by fuzz
  - [x] Task 4.2: VotingLocker checkpoint — all 7 properties proven
  - [x] Task 4.3: Merkle module — not feasible (Poseidon precompile); documented in `reports/formal-verification-phase4.md`
- [x] Phase 5: Manual review (Tasks 5.1–5.3)
  - [x] Task 5.1: `reports/manual-review-correctness.md`
  - [x] Task 5.2: `reports/manual-review-security.md`
  - [x] Task 5.3: `reports/manual-review-architecture.md`
- [x] Phase 6: Integration and final report (Tasks 6.1–6.3)
  - [x] Task 6.1: `reports/integration-flows.md` — flows documented; 262+59 tests pass
  - [x] Task 6.2: `reports/cross-contract-invariants.md`
  - [x] Task 6.3: `reports/CONTRACT_ANALYSIS_REPORT.md` — executive summary and findings

---

## Executor's Feedback or Assistance Requests

**Crowdfund UI header polish started (2026-04-24):** User requested Executor mode. Scope is the existing crowdfund UI header only: shared `AppShell` controls observer/committer chrome, committer `PageNav` controls the selected tab underline, and committer wallet chrome controls RainbowKit button presentation. Success criteria: header is inset with rounded border, active nav underline sits on the header border, wallet control has an icon/pill treatment, and typography spacing better matches the reference.

**Crowdfund UI header polish completed (2026-04-24):** Updated `AppShell` to use an inset rounded header shell with refined brand/network typography; updated committer `PageNav` so the active tab underline sits on the header border; replaced the default RainbowKit header button with a custom icon pill. Verification: IDE lints clean; `npm --workspace @armada/crowdfund-shared run typecheck` passed; `npm --workspace @armada/crowdfund-committer run build` passed. Browser inspection confirmed the header shell and underline; app body was waiting for seeds in local data state.

**Crowdfund UI header follow-up (2026-04-24):** User requested removing the inset treatment. Updated `AppShell` to a normal full-width sticky top header with a bottom border while preserving the refined brand/network typography, border-aligned active tab underline, and custom wallet pill.

**Crowdfund UI header underline follow-up (2026-04-24):** User requested the active selected tab underline appear inline with the bottom border, not above it. Updated committer `PageNav` so horizontal tabs stretch to the header height and render the active indicator as an absolute overlay at the border line.

**Crowdfund UI wallet chrome follow-up (2026-04-24):** User requested muting wallet chrome text and replacing the Lucide wallet glyph with `crowdfund-ui/packages/shared/src/assets/color_circle.svg`. Updated the committer custom RainbowKit header button to import and render that SVG in both disconnected and connected states, with muted foreground text and foreground hover.

**Crowdfund tree campaign header follow-up (2026-04-24):** User requested removing the campaign header card background/border, adding muted vertical stat separators, and changing stat labels away from all-caps. Updated the committer live header, committer stress/mock header, and observer header definitions.

**Crowdfund tree legend follow-up (2026-04-24):** User requested removing the legend title and collapsible affordance/functionality. Updated `GraphLegend` to render only the legend rows, with no local open state, button, or chevron icons.

**Crowdfund tree participate CTA follow-up (2026-04-24):** User requested the bottom "Ready to join this network?" CTA be inset with rounded border, centered content, darker/desaturated white-text button, and smaller text with more vertical spacing. Updated the shared `TreeView` participate CTA wrapper plus committer live and stress/mock CTA content.

**Crowdfund tree participate CTA spacing follow-up (2026-04-25):** User reported changing flex `gap` did not affect on-screen spacing. Updated both live and stress/mock CTA variants to use explicit desktop button margin (`sm:ml-16`) with `sm:gap-0`, making the text-to-button spacing deterministic.

**Phase 1 complete (Tasks 1.1, 1.3).** Task 1.2 (Aderyn) skipped: Rust toolchain not configured (`rustup default stable` needed). User can run `cargo install aderyn && aderyn .` manually and merge results into `reports/static-analysis-summary.md`.

**Slither findings:** 189 total. Key action items: ArmadaYieldAdapter.lendPrivate (use SafeERC20 for shareToken.transfer), PrivacyPool.initialize zero-checks, ArmadaTreasuryGov.constructor zero-check. See `reports/static-analysis-summary.md` for full triage.

**Phase 2 complete:** Threat models created for privacy pool, yield, governance/crowdfund. See `reports/threat-model-*.md`.

**Phase 3 complete:** YieldInvariant.t.sol (4 invariants), BoundaryFuzz.t.sol (boundary tests). All 59 Foundry tests pass. Use `forge test --offline` (or `npm run test:forge`) — sandboxed envs need --offline to avoid Foundry crash.

**Phase 4 complete:** Halmos formal verification. 13 properties proven (allocation, checkpoint, fee). SMT-undecidable properties covered by fuzz. Merkle module not feasible (Poseidon precompile). See `reports/formal-verification-phase4.md`. Run `npm run halmos` or `npm run halmos:allocation`, `halmos:checkpoint`, `halmos:fee`. Requires `halmos.toml` with `forge-build-out = "forge-out"`.

**Phase 5 complete:** Manual review checklists. Correctness (overflow, div-by-zero, rounding, state machine), Security (reentrancy, access control, input validation, oracle risk), Architecture (upgradeability, proxy safety, trust, centralization). See `reports/manual-review-*.md`.

**Phase 6 complete:** Integration flows documented (`reports/integration-flows.md`), cross-contract invariants (`reports/cross-contract-invariants.md`), final report (`reports/CONTRACT_ANALYSIS_REPORT.md`). All 262 Hardhat + 59 Foundry tests pass. **Contract analysis plan complete.**

---

## Lessons

- **Crowdfund UI verification preference (2026-04-24):** Do not rebuild crowdfund apps after small UI changes unless the user asks. Prefer lints or targeted type checks when useful.
- **Relayer function selectors (2025-02-13):** The relayer's `ALLOWED_SELECTORS` must match the compiled contract ABI. Use `forge-out/ArmadaYieldAdapter.sol/ArmadaYieldAdapter.json` to derive selectors: `lendAndShield` = 0xf2987ad1, `redeemAndShield` = 0x0793b70e. Do not hardcode selectors from documentation or older builds.
- **Slither fixes applied (2025-02-13):** ArmadaYieldAdapter.lendPrivate (shareToken.safeTransfer), PrivacyPool.initialize (zero-checks for all address params), PrivacyPool.setTreasury (zero-check), ArmadaTreasuryGov.constructor (zero-check). All 262 tests pass.
- **Foundry:** Use `forge test --offline` in sandboxed environments to avoid SCDynamicStoreBuilder crash (macOS proxy lookup).
- **Halmos:** foundry.toml uses `out = "forge-out"`. Add `[global] forge-build-out = "forge-out"` to `halmos.toml` so Halmos finds the build output.

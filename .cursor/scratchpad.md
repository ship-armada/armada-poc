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

### Crowdfund UI Sepolia Sync Architecture (2026-04-28)

Planner analysis: Observer/committer Sepolia cold loads are slow because browser-side event sync currently scans from `deployBlock` through `useContractEvents` and shared `fetchLogs`, which chunks `eth_getLogs` into 10-block ranges with delay. Recommended architecture is a hosted indexer plus frontend snapshot/delta hydration, with the existing RPC scanner retained as a fallback/dev path.

Resilience requirement: the indexer must be a performance accelerator, not the source of truth. Sepolia remains canonical. Campaign-ready design needs append-only raw log storage, disposable derived snapshots, independent audit checks against RPC, recent overlap rescans, backups, health/staleness metadata, and frontend degraded-mode behavior so an indexer outage or DB issue does not blank the app.

No-gap ingestion rule: use separate `ingestedCursor` and `verifiedCursor`. The frontend should only trust data up to `verifiedCursor`. If block/range `x` fails, times out, or audits suspiciously while later ranges are fetched, verification must stop before `x` until a repair job re-fetches and verifies that range. On RPC downtime, failed ranges remain queued; on indexer crash, restart from durable range records and re-scan an overlap window before promoting verified snapshots.

Manageable resilience additions to include in implementation: static verified snapshot fallback (`snapshot-{block}.json` plus `latest.json`), contract-read reconciliation against aggregate reads before snapshot promotion, operator CLI commands (`status`, `verify`, `repair`, `rebuild-snapshot`, `publish-snapshot`), frontend transaction receipt fast-path for confirmed user writes, snapshot schema/deployment guards, and a health endpoint with deterministic frontend policies for healthy/stale/degraded/unhealthy/unavailable states.

Repo placement and branching: build the service as a new Node/TypeScript workspace package at `crowdfund-ui/packages/indexer` named `@armada/crowdfund-indexer`, so it can reuse shared crowdfund event/graph logic and fit the existing `crowdfund-ui/packages/*` workspace glob. Before implementation, create `feature/crowdfund-sync-indexer` from the current `iskay/crowdfund-ui-polish` branch, not from `main`; carry or intentionally handle current planning edits before branching.

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
- [x] Crowdfund indexer Task 1: created `feature/crowdfund-sync-indexer`; scaffolded `@armada/crowdfund-indexer` package; added snapshot/health/range data contracts and pure no-gap ingestion helpers.
- [x] Crowdfund indexer Task 2: added JSON persistence-backed range store and initial indexer status/repair CLI command layer.
- [x] Crowdfund indexer Task 3: implemented RPC-backed range fetch/audit/repair pipeline against persisted store.
- [x] Crowdfund indexer Task 4: implemented snapshot building/publication and contract-read reconciliation.
- [x] Crowdfund indexer Task 5: exposed snapshot/health HTTP API and integrated observer/committer indexed data source.
- [x] Crowdfund indexer Task 6: added frontend stale/degraded banners and transaction receipt fast-path.
- [x] Crowdfund indexer Task 7: added automatic chunked backfill/scheduler entry point.
- [x] Crowdfund indexer Task 8: added Postgres-backed durable store and runtime store backend selection.
- [x] Crowdfund indexer Task 9: added S3-compatible object-storage snapshot publication backend.
- [x] Crowdfund indexer Task 10: added backup/restore operator docs.
- [ ] Crowdfund indexer Task 11: run an end-to-end Sepolia/local smoke test with live indexer API and configured frontends.
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

**Crowdfund committer next-steps rail (2026-04-26):** User approved moving "What happens next?" cards lower in visual hierarchy. Added a compact `rail` variant to `WhatsNextCard` and introduced `PageWithHelp` in committer so Participate/Claim main content remains centered while next steps render as a subtle right-margin rail on wide screens and below content on smaller screens.

**Crowdfund checkout polish (2026-04-26):** Updated Participate checkout styling to better match the design mockup: shared `Stepper` now uses numbered progress dots with labels and top caption, shared `StepFooter` uses more polished back/primary button chrome, Participate entry cards have icon blocks/accent borders, and commit/invite/claim review/detail/status surfaces use softer accent-tinted borders/backgrounds. Verification: IDE lints clean for touched files; `npm --workspace @armada/crowdfund-shared run typecheck` passed; direct committer TypeScript project check passed via `./node_modules/.bin/tsc -b /Users/ikay/conductor/workspaces/poc/taipei/crowdfund-ui/packages/committer/tsconfig.json`. No app rebuild run per user preference.

**Crowdfund checkout helper text removal (2026-04-26):** User clarified that the visible "Step X · label" copy was mockup helper text. Removed the shared `Stepper` caption from checkout forms and removed the Participate entry picker's "Step 1 · Choose entry" strip. Verification: IDE lints clean for touched files.

**Crowdfund participate entry stacking (2026-04-26):** User requested the first Participate form options stack vertically instead of side by side. Removed the desktop two-column grid from the entry picker. Verification: IDE lints clean for `committer/src/App.tsx`.

**Crowdfund participate entry option layout (2026-04-26):** User requested text in each option card sit to the right of the icon. Updated both entry buttons to use horizontal icon/text layout with fixed-size icon blocks and wrapped copy. Verification: IDE lints clean for `committer/src/App.tsx`.

**Crowdfund participate entry accent unification (2026-04-26):** User requested both entry options use purple accents. Updated the Invite option hover, border, icon background, and icon color from primary blue to `hop-0` purple. Verification: IDE lints clean for `committer/src/App.tsx`.

**Crowdfund commit context position list (2026-04-26):** User requested removing the card treatment from the Confirm context positions list. Simplified each position row to plain inline list rows without border/background/shadow. Verification: IDE lints clean for `CommitTab.tsx`.

**Crowdfund participate primary button accent (2026-04-26):** User requested Continue/Confirm buttons on participate forms use purple instead of blue. Updated shared `StepFooter` default primary action styling to `hop-0` purple and switched the invite-link create action to the same purple treatment. Verification: IDE lints clean for touched files.

**Crowdfund commit amount input card removal (2026-04-26):** User requested removing the card around the amount input on the Commit amount form. Removed border/background/padding/shadow from each per-hop amount input wrapper while preserving labels, demand context, and validation. Verification: IDE lints clean for `CommitTab.tsx`.

**Crowdfund amount max button polish (2026-04-26):** User requested the Max button be more subtle, ghosted instead of solid blue, and vertically centered with the amount input. Updated shared `AmountInput` to use a ghost-style Max button with muted text, subtle border, purple hover tint, and `h-11` alignment. Verification: IDE lints clean for `AmountInput.tsx`.

**Crowdfund invite confirm regression fix (2026-04-26):** User reported clicking "Confirm transaction" on direct invite after entering an address did nothing. Root cause: shared `StepFooter` passed the React click event into `onNext`; `InviteTab.runPipeline` has an optional override parameter, so it interpreted the event as an override and returned before sending. Fixed `StepFooter` to invoke callbacks with no event argument and added `Stepper.test.tsx` regression coverage. Verification: `npm --workspace @armada/crowdfund-shared run test -- Stepper` passed; shared typecheck passed; committer TypeScript project check passed; IDE lints clean.

**Crowdfund indexer Task 1 checkpoint (2026-04-28):** User approved the indexer architecture plan and requested implementation. Created feature branch `feature/crowdfund-sync-indexer` from `iskay/crowdfund-ui-polish`. Added new workspace package `crowdfund-ui/packages/indexer` (`@armada/crowdfund-indexer`) with TypeScript/Vitest config, snapshot/health/cursor data contracts, deterministic range digest/log identity helpers, contiguous verified-cursor promotion, gap detection, repair range extraction, and health classification. Added root script `npm run crowdfund:indexer`. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (9 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; IDE lints clean.

**Crowdfund indexer Task 2 checkpoint (2026-04-28):** Added `FileIndexerStore`, a JSON-file backed durable store for cursor, range records, snapshot metadata, and health timestamps using atomic write/rename. Added initial operator CLI command layer with `status` output and accepted stubs for `verify`, `repair`, `rebuild-snapshot`, and `publish-snapshot`; added root `npm run crowdfund:indexer:cli`. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (16 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; `npm run crowdfund:indexer:cli -- status` produced clean status output; IDE lints clean.

**Crowdfund indexer Task 3 checkpoint (2026-04-28):** Added append-only raw log persistence to the file store. Implemented `fetchIndexedLogs`, `stageRange`, `verifyRange`, and `repairRanges` with provider/audit-provider digest comparison, failed/suspicious range recording, raw log dedupe, and contiguous verified-cursor promotion. Wired `verify` and `repair` CLI commands to the RPC pipeline via `CROWDFUND_PRIMARY_RPC_URL`, optional `CROWDFUND_AUDIT_RPC_URL`, and `CROWDFUND_CONTRACT_ADDRESS`. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (22 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; `npm run crowdfund:indexer:cli -- status` produced clean status output; IDE lints clean.

**Crowdfund indexer Task 4 checkpoint (2026-04-28):** Added verified snapshot construction from persisted raw logs using shared event parsing and graph building, deterministic bigint/Map-safe JSON serialization and snapshot hashing, static `snapshot-{block}.json` plus `latest.json` publication, and contract-read reconciliation against participant count, per-hop totals, per-hop capped demand, unique committers, and whitelist counts. Wired `rebuild-snapshot` and `publish-snapshot` CLI commands; publish refuses failed reconciliation and can publish pending-reconciliation snapshots when no RPC URL is configured. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (27 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; smoke-tested `publish-snapshot` with temp store/snapshot dir; IDE lints clean.

**Crowdfund indexer Task 5 checkpoint (2026-04-28):** Added Express API server for `/health`, `/snapshot`, and `/events` delta responses from the verified store. Added shared frontend indexer client helpers that revive JSON stringified bigint event fields back into `CrowdfundEvent` shapes. Updated `useContractEvents` to try an indexed snapshot first when `indexerBaseUrl` is provided, validating contract address and deploy block before falling back to the existing IndexedDB/RPC sync path. Wired observer and committer Sepolia config to `VITE_CROWDFUND_INDEXER_URL` while local mode stays RPC-only. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (28 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; `npm run test --workspace=@armada/crowdfund-shared -- indexer` passed; `npm run typecheck --workspace=@armada/crowdfund-shared` passed; direct observer/committer TypeScript project check passed; smoke-started API on temp port and stopped it; IDE lints clean.

**Crowdfund indexer Task 6 checkpoint (2026-04-28):** Added indexer health fetching to shared frontend client code and surfaced non-healthy indexer states through `StaleDataBanner` (`stale`, `degraded`, `unhealthy`, `unavailable`). Extended `useContractEvents` to poll indexer health and expose it to observer/committer. Added receipt fast-path: confirmed commit, invite, and claim/refund transaction receipt logs are parsed and merged into the event query/cache immediately, so the connected user's UI updates before indexer catch-up. Verification: `npm run test --workspace=@armada/crowdfund-shared -- indexer StaleDataBanner` passed (existing `useStaleDataBanner` act warnings still present); `npm run typecheck --workspace=@armada/crowdfund-shared` passed; direct observer/committer TypeScript project check passed; `npm run test --workspace=@armada/crowdfund-indexer && npm run typecheck --workspace=@armada/crowdfund-indexer` passed; `npm run crowdfund:indexer:cli -- status` passed; IDE lints clean.

**Crowdfund indexer Task 7 checkpoint (2026-04-28):** Added provider-safe chunked backfill orchestration. `planBackfillRanges` creates inclusive chunks from `verifiedCursor + 1` to confirmed head; `backfillVerifiedRanges` verifies each chunk sequentially, updates chain/confirmed head, promotes `verifiedCursor` only through verified contiguous chunks, and stops on failed/suspicious ranges by default. Added CLI `backfill` command and `CROWDFUND_BACKFILL_ON_START=true` API startup catch-up option, both using `CROWDFUND_MAX_BLOCK_RANGE` (default 500). Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (33 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; `npm run crowdfund:indexer:cli -- backfill latest` now parses correctly and fails only for missing expected RPC env; IDE lints clean.

**Crowdfund indexer Task 8 checkpoint (2026-04-28):** Added `IndexerStore` interface and `PostgresIndexerStore` with migrations for cursor, range verification records, append-only raw logs, and metadata. Added runtime store selection via `CROWDFUND_INDEXER_STORE=file|postgres`; if unset, `CROWDFUND_DATABASE_URL`/`DATABASE_URL` selects Postgres and otherwise the JSON file store remains the local/dev fallback. CLI and API now use the store factory. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (38 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; IDE lints clean. `npm audit --omit=dev` was run after dependency warnings and reports existing workspace vulnerabilities, several of which require breaking or force fixes; no audit fix was applied.

**Crowdfund indexer Task 9 checkpoint (2026-04-28):** Added S3-compatible object storage publication for static verified snapshots. `publish-snapshot` now supports `CROWDFUND_SNAPSHOT_PUBLISHER=file|s3`; S3 mode writes immutable `snapshot-{verifiedBlock}.json` and mutable `latest.json` to `CROWDFUND_SNAPSHOT_BUCKET` with optional `CROWDFUND_SNAPSHOT_PREFIX`, `CROWDFUND_SNAPSHOT_ENDPOINT`, `CROWDFUND_SNAPSHOT_REGION`, `CROWDFUND_SNAPSHOT_PUBLIC_BASE_URL`, and `CROWDFUND_SNAPSHOT_FORCE_PATH_STYLE`. Store metadata records the public `latest.json` URL when configured, otherwise the `s3://` URI. Verification: `npm run test --workspace=@armada/crowdfund-indexer` passed (39 tests); `npm run typecheck --workspace=@armada/crowdfund-indexer` passed; IDE lints clean.

**Crowdfund indexer Task 10 checkpoint (2026-04-28):** Added `docs/CROWDFUND_INDEXER_RUNBOOK.md` covering runtime model, required env vars, Postgres and local file stores, S3-compatible static snapshot publishing, API startup, CLI operations, normal operating loop, failure recovery, backup checklist, and smoke test checklist. Accuracy checked against current CLI/API/store/publisher env handling. No code tests needed for docs-only change.

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
- **Crowdfund indexer shared imports (2026-04-28):** Do not import from the `@armada/crowdfund-shared` barrel in Node indexer code, even for types, because the barrel pulls TSX/browser modules into indexer typecheck. Import type-only from pure shared lib files such as `../../shared/src/lib/events.js` and `../../shared/src/lib/graph.js` until shared exposes server-safe subpath exports.
- **Crowdfund indexer CLI runner (2026-04-28):** `ts-node-esm` fails with `ERR_UNKNOWN_FILE_EXTENSION` in this NodeNext/package ESM setup. Use `node --no-warnings --loader ts-node/esm` for current indexer `dev`/`cli` scripts until the package gains a build step or a different TS runner.
- **Crowdfund indexer CLI args (2026-04-28):** The root nested npm script can strip flags like `--to` when forwarding to the workspace script. Support `npm run crowdfund:indexer:cli -- backfill latest` as shorthand for `backfill --to latest`.
- **Crowdfund indexer dependencies (2026-04-28):** When adding dependencies for nested `crowdfund-ui` workspaces, run workspace installs from `crowdfund-ui/` if the repo-root workspace filter warns that the package is not present. Root-level installs can still update root audit output without adding the intended package dependency.
- **Relayer function selectors (2025-02-13):** The relayer's `ALLOWED_SELECTORS` must match the compiled contract ABI. Use `forge-out/ArmadaYieldAdapter.sol/ArmadaYieldAdapter.json` to derive selectors: `lendAndShield` = 0xf2987ad1, `redeemAndShield` = 0x0793b70e. Do not hardcode selectors from documentation or older builds.
- **Slither fixes applied (2025-02-13):** ArmadaYieldAdapter.lendPrivate (shareToken.safeTransfer), PrivacyPool.initialize (zero-checks for all address params), PrivacyPool.setTreasury (zero-check), ArmadaTreasuryGov.constructor (zero-check). All 262 tests pass.
- **Foundry:** Use `forge test --offline` in sandboxed environments to avoid SCDynamicStoreBuilder crash (macOS proxy lookup).
- **Halmos:** foundry.toml uses `out = "forge-out"`. Add `[global] forge-build-out = "forge-out"` to `halmos.toml` so Halmos finds the build output.

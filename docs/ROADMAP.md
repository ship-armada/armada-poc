# Armada — Sepolia Testnet Milestone

**Goal:** Fully functional Sepolia testnet deployment with all critical and triaged-high bugs fixed, governance bugs resolved, and all four core user flows validated end-to-end from the frontend.

**In scope:** Privacy Pool, Yield, Governance, Crowdfund, Relayer (phase 1), Frontend, Deployment/Infra.

**Out of scope:** Mainnet hardening, Relayer phases 2–5, frontend rewrite, custom circuits, cross-chain MASP.

**Legend:**
- `[BLOCKER]` — Must be resolved before Sepolia deploy
- `[SHOULD]` — Should be resolved; known risk if deferred
- `[DONE]` — Already fixed; included for audit trail and confidence
- `(depends: X.Y)` — Cannot start until item X.Y is complete

---

## Work Queue

Ordered checklist for sequential execution. Work items at the same level can be done in parallel. Check off items here as they are completed — each references a detailed description in the sections below.

### Level 0 — Contract Fixes (no dependencies, start here)

- [ ] **1.1-A** C-1/C-2: Remove `setTestingMode()` and `VERIFICATION_BYPASS` → _§1.1_
- [x] **1.1-B** H-1/H-2: Validate `remoteDomain` + `sender` on cross-chain shields → _§1.1_
- [x] **1.1-C** H-5: Add `_disableInitializers()` to PrivacyPool → _§1.1_
- [ ] **2.1-A** H-4: Fix yield vault cost basis corruption → _§2.1_
- [x] **3.1-A** #4: Add unlock cooldown to VotingLocker → _§3.1_
- [x] **3.1-B** #23: Add claim revocability to TreasuryGov → _§3.1_
- [x] **3.1-C** #29: Fix garbled revert in steward over-budget → _§3.1_
- [x] **3.1-D** H-8: Proposal threshold — use eligible supply → _§3.1_
- [x] **3.2-A** #16: Verify steward `allowedTargets` deploy config + write test → _§3.2_
- [x] **3.2-B** #17: Verify `minActionDelay()` covers veto cycle + write test → _§3.2_
- [x] **4.1-A** H-10: Add ARM recovery for canceled crowdfund → _§4.1_
- [x] **5.1-A** C-4: Add private key startup assertion to relayer → _§5.1_
- [ ] **7.1-A** Run Aderyn static analysis → _§7.1_

### Level 1 — Tests & Triage (depends on Level 0 fixes)

- [x] **3.2-C** #19: Write regression test — snapshot quorum doesn't shift mid-vote → _§3.2_
- [ ] **3.4-A** Cover governance scenarios: A4, D8-D10, E-series, J9, M8 → _§3.4_
- [ ] **4.3-A** Cover crowdfund scenarios: cancel+ARM recovery, elastic expansion, permissionlessCancel → _§4.3_
- [x] **1.3-A** Add Foundry invariant: pool USDC balance = unspent commitments → _§1.3_
- [ ] **7.1-B** Triage Aderyn findings — fix any new critical/high → _§7.1_
- [ ] Run `npm run test:all` — all Hardhat tests pass
- [ ] Run `npm run test:forge` — all Foundry tests pass

### Level 2 — Deploy (depends on Level 0–1)

- [ ] **7.1-C** Deploy to Sepolia from clean state (`npm run setup:sepolia`) → _§7.1_
- [ ] **6.1-A** Verify Sepolia network config (`VITE_NETWORK=sepolia`) → _§6.1_
- [ ] **6.1-B** Confirm `VITE_RELAYER_URL` set for Sepolia → _§6.1_
- [ ] **5.2-A** Restrict CORS to frontend origin (M-16) → _§5.2_

### Level 3 — Validate (depends on Level 2)

- [ ] **7.1-D** Run smoke tests (`npm run test:sepolia --check --shield --cross-chain`) → _§7.1_
- [ ] **7.1-E** Confirm `testingMode=false` on deployed PrivacyPool → _§7.1_
- [ ] **5.3-A** Confirm Iris attestation relay E2E on Sepolia → _§5.3_
- [ ] **6.3-A** Test hub shield from frontend (Ethereum Sepolia → pool) → _§6.3_
- [ ] **6.3-B** Test cross-chain shield from frontend (Base Sepolia → hub) → _§6.3_
- [ ] **6.3-C** Test cross-chain unshield from frontend (hub → Base Sepolia) → _§6.3_
- [ ] **6.3-D** Test private transfer from frontend (hub → hub) → _§6.3_

### Should-Fix (non-blocking, work on after blockers are clear)

- [ ] **1.2-A** H-11: Put PrivacyPool owner behind Timelock → _§1.2_
- [ ] **1.2-B** H-12: Add ReentrancyGuard to pool module entry points → _§1.2_
- [ ] **1.2-C** M-1: Fix `safeApprove` without reset in TransactModule → _§1.2_
- [ ] **1.2-D** C-3: Align shield fee formula (contract vs SDK) → _§1.2_
- [ ] **2.2-A** M-4: Mitigate first depositor inflation attack → _§2.2_
- [ ] **2.2-B** M-17: Add $1 minimum deposit guard → _§2.2_
- [ ] **3.3-A** N1: Investigate votes on canceled proposals → _§3.3_
- [ ] **3.3-B** H-9: Document or fix abstain votes in quorum → _§3.3_
- [ ] **4.2-A** M-7: Add finalization deadline → _§4.2_
- [ ] **4.2-B** Add admin transfer function to crowdfund → _§4.2_
- [ ] **6.2-A** Connect fee display to relayer `/fees` API → _§6.2_
- [ ] **1.3-B** Integration test with real SNARK proof → _§1.3_
- [ ] **2.3-A** Integration test: `lendAndShield`/`redeemAndShield` with real proofs → _§2.3_
- [ ] **7.2-A** Verify Railgun SDK LevelDB doesn't load stale data → _§7.2_
- [ ] **7.2-B** Document secrets management process → _§7.2_
- [ ] **7.2-C** Add cross-contract invariant tests for TreasuryGov + ARM supply → _§7.2_

---

## 1. Privacy Pool

### 1.1 Security — Blockers

- [ ] `[BLOCKER]` **C-1/C-2: Remove or gate `setTestingMode()` and `VERIFICATION_BYPASS`**
  Owner can disable all SNARK verification via `setTestingMode(true)`. Separately, `tx.origin == 0xdead` bypasses proof verification. Both must be unreachable on Sepolia. Options: compile-time flag, deploy separate contracts, or hard-disable at initialization.
  _Ref: Audit C-1, C-2 | `PrivacyPool.sol:291-298`, `VerifierModule.sol:67,106`, `Globals.sol:10`_

- [x] `[DONE]` **H-1/H-2: Validate `remoteDomain` on incoming cross-chain shields**
  Added `require(remotePools[remoteDomain] != bytes32(0))` to `handleReceiveFinalizedMessage()`. Messages from unregistered domains are now rejected. The `sender` parameter (remote TokenMessenger) is already authenticated by CCTP's attestation layer; the domain check ensures only registered client chains can shield. 5 fuzz + 4 unit tests in Foundry.
  _Ref: Audit H-1, H-2 | `PrivacyPool.sol:168` | `test-foundry/PrivacyPoolSecurityBlockers.t.sol`_

- [x] `[DONE]` **H-5: Prevent front-running `initialize()` via deployer-only guard**
  Added `immutable _deployer` set in constructor for both `PrivacyPool` and `PrivacyPoolClient`. `initialize()` now requires `msg.sender == _deployer`. Declared in each contract (not in shared storage) to avoid forcing constructors on all modules. 1 fuzz + 5 unit tests in Foundry.
  _Ref: Audit H-5 | `PrivacyPool.sol`, `PrivacyPoolClient.sol` | `test-foundry/PrivacyPoolSecurityBlockers.t.sol`_

### 1.2 Security — Should Fix

- [ ] `[SHOULD]` **H-11: Put PrivacyPool owner behind a Timelock**
  Pool owner can instantly change fees, set verification keys, and enable testing mode. For testnet the deployer EOA is the owner — acceptable but should be the TimelockController for defense in depth.
  _Ref: Audit H-11_

- [ ] `[SHOULD]` **H-12: Add `ReentrancyGuard` to PrivacyPool module entry points**
  `shield`, `transact`, and `atomicCrossChainUnshield` delegate to modules but hold no reentrancy lock at the pool level. USDC has no hooks so risk is theoretical, but this is a defense-in-depth gap.
  _Ref: Audit H-12 | `PrivacyPool.sol`_

- [ ] `[SHOULD]` **M-1: Replace `safeApprove` without reset in TransactModule**
  `_executeCCTPBurn` calls `safeApprove(tokenMessenger, base)` without first resetting to zero. OpenZeppelin's `safeApprove` reverts if current allowance is non-zero. Will fail on second cross-chain unshield if prior approval wasn't fully consumed.
  _Ref: Audit M-1 | `TransactModule.sol:200`_

- [ ] `[SHOULD]` **C-3: Align shield fee formula between contract and SDK**
  Spec documents additive/exclusive fee; code implements multiplicative/inclusive. Divergence is ~0.0025% at 50 bps but grows at higher rates. Align code and spec (multiplicative is simpler — update the spec).
  _Ref: Audit C-3 | `ShieldModule.sol:263-266`_

### 1.3 Test Coverage

- [x] `[DONE]` **Add Foundry invariant: PrivacyPool USDC balance = sum of unspent commitments**
  6 invariants in `test-foundry/PrivacyPoolBalanceInvariant.t.sol`: INV-B1 (pool balance equation), INV-B2 (total USDC conservation across pool + treasury + recipients), INV-B3 (treasury fee accumulation), INV-B4 (pool solvency), INV-B5a/b (fee math consistency for shield and unshield). Handler exercises both `shieldRandom` and `unshieldRandom` with 50/50 call distribution.
  _Ref: `reports/cross-contract-invariants.md` Gap #1 | `test-foundry/PrivacyPoolBalanceInvariant.t.sol`_

- [ ] `[SHOULD]` **Add integration test with real SNARK proof (testingMode=false)**
  All current integration tests use `testingMode=true`. At minimum one test should generate a real Groth16 proof, submit it against a valid verification key, and confirm it passes.
  _Ref: `reports/integration-flows.md` Gaps_

### 1.4 Already Fixed

- [x] `[DONE]` H-3: `onlyDelegatecall` guards added to all module external functions (PR #57)
- [x] `[DONE]` Zero-address checks on `PrivacyPool.initialize` and `setTreasury` (static analysis remediation)

---

## 2. Yield

### 2.1 Security — Blockers

- [ ] `[BLOCKER]` **H-4: Fix cost basis corruption from shared adapter identity**
  `ArmadaYieldVault` tracks `userCostBasisPerShare[owner]` keyed by share owner address. When `ArmadaYieldAdapter` holds shares on behalf of multiple users (relay flows), all positions share one cost basis entry. Either key by per-user nonce/hash, or ensure the adapter never holds mixed-user shares simultaneously.
  _Ref: Audit H-4 | `ArmadaYieldVault.sol:84-174`_

### 2.2 Security — Should Fix

- [ ] `[SHOULD]` **M-4: Mitigate first depositor inflation attack**
  No virtual shares or minimum deposit. First depositor can manipulate the exchange rate. Add ERC-4626-style virtual offset (`totalAssets + 1` / `totalSupply + 1`) or enforce a minimum first deposit.
  _Ref: Audit M-4 | `ArmadaYieldVault.sol:382-393`_

- [ ] `[SHOULD]` **M-17: Add minimum deposit guard ($1 USDC)**
  Fuzzer found share price can decrease by >1 bps on sub-dollar dust deposits after yield accrual. Add `require(assets >= 1e6)` guard.
  _Ref: Audit F-1 / M-17 | `ArmadaYieldVault.sol`_

### 2.3 Test Coverage

- [ ] `[SHOULD]` **Add integration test: `lendAndShield` / `redeemAndShield` with real proofs**
  Both flows currently tested only via trusted-relayer shortcut (`lendPrivate`/`redeemPrivate`). Add test confirming the ZK-proof-bound path works.
  _Ref: `reports/integration-flows.md` Gaps_

### 2.4 Already Fixed

- [x] `[DONE]` `unchecked-transfer` in `ArmadaYieldAdapter.lendPrivate` replaced with `safeTransfer`

---

## 3. Governance

> **Note:** Issues #24, #25, #26, #27, #28, #30, #31, #33, #34, #35, #38 were resolved in PRs #50, #54, #60–63. Verified in code — do not reopen.

### 3.1 Security — Blockers

- [x] `[DONE]` **#4: Unlock cooldown prevents vote-and-dump**
  Added `recordVoteCooldown()` mechanism: when a user votes, ArmadaGovernor records the proposal's `voteEnd` timestamp in VotingLocker. Unlock is blocked until `block.timestamp > unlockCooldownEnd[user]`. Voting on multiple proposals extends cooldown to the latest `voteEnd`. 14 Hardhat tests + 17 Foundry tests (3 unit, 3 fuzz, 8 scenario, 2 invariant + handler) verify the fix.
  _Ref: `VotingLocker.sol:recordVoteCooldown()`, `ArmadaGovernor.sol:castVote()`, `test-foundry/UnlockCooldown.t.sol`, `test/governance_unlock_cooldown.ts`_

- [x] `[DONE]` **#23: Add revocability to TreasuryGov claims**
  Added `revokeClaim(claimId)` callable only by owner (timelock), and `expiresAt` field on claims (0 = never expires). Revoked/expired claims return 0 from `getClaimRemaining()` and revert on `exerciseClaim()`. Includes Hardhat integration tests (10 scenarios) and Foundry fuzz tests (7 property-based tests).
  _Ref: GitHub #23 | `ArmadaTreasuryGov.sol`_

- [x] `[DONE]` **#29: Fix garbled revert when steward exceeds budget**
  Verified: the assembly revert bubbling in `executeAction()` (lines 209-214) correctly propagates the original error message. Existing tests in `governance_adversarial.ts` and `governance_integration.ts` confirm the revert reason "ArmadaTreasuryGov: exceeds monthly budget" surfaces correctly through the action queue. This was effectively resolved by the error encoding fix in PR #50 (#35).
  _Ref: GitHub #29 | `TreasurySteward.sol`_

- [x] `[DONE]` **H-8: Proposal threshold now uses eligible supply**
  Extracted `_getEligibleSupply()` internal function (totalSupply minus treasury and excluded addresses). Both `_checkProposalThreshold()` and `proposalThreshold()` now use eligible supply, consistent with quorum. 10 Foundry tests (3 unit + 4 fuzz + 3 scenario) verify the fix.
  _Ref: `ArmadaGovernor.sol:_getEligibleSupply()`, `test-foundry/ProposalThresholdEligibleSupply.t.sol`_

### 3.2 Verification Required

- [x] `[DONE]` **#16: Verify deployment script only adds treasury to steward `allowedTargets`**
  Verified: `deploy_governance.ts` passes only `treasuryAddress` to TreasurySteward constructor, which auto-whitelists it (line 96). No `addAllowedTarget` calls in deploy script. 9 Foundry tests (4 unit, 1 fuzz, 4 scenario) confirm steward cannot target governor, locker, timelock, or arbitrary addresses.
  _Ref: `test-foundry/GovernanceVerification.t.sol:StewardAllowedTargetsTest`_

- [x] `[DONE]` **#17: Verify `minActionDelay()` covers a full governance veto cycle**
  Verified: `minActionDelay()` = 120% of fastest governance cycle (ParameterChange: 2d+5d+2d = 9d → 10.8d). This gives governance 1.8 days of slack to execute a veto. 8 Foundry tests (5 unit, 2 fuzz, 1 dynamic) prove governance completes veto before steward can execute, and minDelay tracks governor param changes dynamically.
  _Ref: `test-foundry/GovernanceVerification.t.sol:MinActionDelayVetoCycleTest`_

- [x] `[DONE]` **#19: Regression test confirming snapshot quorum doesn't shift during voting**
  **Foundry (8 tests):** 6 unit, 1 fuzz, 1 concurrent-proposal verify quorum is immutable after proposal creation: treasury deposits/withdrawals mid-vote, governance param updates, excluded address changes, and arbitrary fuzzed transfers all leave quorum unchanged. Concurrent proposals snapshot independently.
  **Hardhat (14 tests):** Covers scenarios D8, D9, D10: treasury donations mid-vote, treasury distributions mid-vote, quorumBps parameter changes, excluded address exclusion, cross-proposal snapshot isolation, and proposal type quorum differences. Existing Foundry invariant test INV-G5 (`GovernorInvariant.t.sol`) also covers quorum immutability via fuzz testing.
  _Ref: `test-foundry/GovernanceVerification.t.sol:SnapshotQuorumRegressionTest` | `test/governance_snapshot_quorum.ts`_

### 3.3 Should Fix

- [ ] `[SHOULD]` **N1: Investigate votes on canceled proposals**
  `castVote` checks `voteStart`/`voteEnd` timestamps but not `state()`. If a proposal is canceled while Pending, votes may be castable when time reaches the original voting window. Investigate and fix if confirmed.
  _Ref: `docs/governance-test-scenarios.md` section N | `ArmadaGovernor.sol`_

- [ ] `[SHOULD]` **H-9: Document or fix abstain votes counting toward quorum**
  Abstain votes are included in the quorum calculation. This is undocumented behavior. Either add NatSpec documenting it as intentional, or exclude abstains from quorum.
  _Ref: Audit H-9 | `ArmadaGovernor.sol:330`_

### 3.4 Test Coverage

- [ ] `[SHOULD]` **Cover priority uncovered governance scenarios**
  223 scenarios documented in `docs/governance-test-scenarios.md`. Priority items for Sepolia confidence:
  - A4 (vote-and-dump) — must be covered once #4 is fixed
  - D8/D9/D10 (quorum snapshot regression) — covers #19 verification
  - E-series (state transition timing edge cases)
  - J9 (steward queues action targeting arbitrary contract) — covers #16 verification
  - M8 (zombie proposal expiry) — verify against existing QUEUE_GRACE_PERIOD implementation
  _Ref: `docs/governance-test-scenarios.md`_

### 3.5 Already Fixed

- [x] `[DONE]` #4: Unlock cooldown — `recordVoteCooldown()` prevents vote-and-dump (`VotingLocker.sol`, `ArmadaGovernor.sol`)
- [x] `[DONE]` #19/#25: Snapshot quorum — `snapshotEligibleSupply` stored at creation (`ArmadaGovernor.sol:274,386`)
- [x] `[DONE]` #22/#28: Queue grace period — `QUEUE_GRACE_PERIOD = 14 days`, proposals expire (`ArmadaGovernor.sol:92,374`)
- [x] `[DONE]` #24: `transferOwnership` removed from TreasuryGov (PR #50)
- [x] `[DONE]` #26: Emergency pause mechanism with auto-expiry (PR #62)
- [x] `[DONE]` #27: Governance-updatable proposal parameters with bounds (PR #63)
- [x] `[DONE]` #30: Snapshot steward budget basis at period start (PR #50)
- [x] `[DONE]` #31: `receive()` removed from TreasuryGov (PR #50)
- [x] `[DONE]` #33: Against votes count toward quorum (PR #50)
- [x] `[DONE]` #34: Steward self-cancellation for proposed actions (PR #60)
- [x] `[DONE]` #35: Error encoding fix in TreasurySteward (PR #50)
- [x] `[DONE]` #38: New steward cannot execute previous steward's actions (PR #60)

---

## 4. Crowdfund

### 4.1 Security — Blockers

- [x] `[DONE]` **H-10: Add ARM recovery path for canceled crowdfund**
  Added `withdrawArmAfterCancel()` callable by admin when `phase == Canceled`. Transfers entire ARM balance to treasury. Reuses `unallocatedArmWithdrawn` flag to prevent double withdrawal. Includes 7 Hardhat integration tests and 6 Foundry fuzz tests.
  _Ref: Audit H-10 | `ArmadaCrowdfund.sol`_

### 4.2 Should Fix

- [ ] `[SHOULD]` **M-7: Add finalization deadline**
  `FINALIZE_GRACE_PERIOD = 30 days` means a dysfunctional admin can delay finalization for a month. Low risk for testnet, but document the value and track for production.
  _Ref: Audit M-7 | `ArmadaCrowdfund.sol:31`_

- [ ] `[SHOULD]` **Add admin transfer function**
  Admin is immutable (set in constructor, no setter). If the admin key is lost, there is no recovery path. Add `transferAdmin(address newAdmin)` callable only by current admin.
  _Ref: `ArmadaCrowdfund.sol:40` (TODO in code)_

### 4.3 Test Coverage

- [ ] `[SHOULD]` **Cover priority uncovered crowdfund scenarios**
  147 of 234 scenarios are uncovered (~37% coverage). Priority items for Sepolia:
  - Canceled phase: ARM recovery after cancel (tied to H-10 fix)
  - Elastic expansion boundary scenarios (5.24-5.29)
  - Full `permissionlessCancel` flow test
  - Allocation precision edge cases (6.9-6.13)
  - Rollover logic (5.24-5.29)
  _Ref: `docs/CROWDFUND_TEST_SCENARIOS.md`_

### 4.4 Already Fixed

- [x] `[DONE]` `ReentrancyGuard` on commit/finalize/claim/refund
- [x] `[DONE]` Allocation math (`allocUsdc + refund == committed`) formally proven by Halmos

---

## 5. Relayer

### 5.1 Security — Blockers

- [x] `[DONE]` **C-4: Enforce env-var private keys with fail-secure startup**
  Added `assertPrivateKeyConfigured()` at the top of the relayer `main()` function. For non-local environments, verifies DEPLOYER_PRIVATE_KEY is set, non-empty, and not the Anvil default key before any module initialization or port binding. `config/networks.ts` already throws for empty keys on non-local envs (line 121-123); the relayer assertion is defense-in-depth. Confirmed: the Sepolia code path in `relayer/config.ts:88-101` uses `netConfig.deployerPrivateKey` exclusively and cannot fall through to hardcoded keys.
  _Ref: Audit C-4 | `relayer/armada-relayer.ts`, `relayer/config.ts:63-75`_

### 5.2 Should Fix

- [ ] `[SHOULD]` **M-16: Restrict CORS on relayer HTTP API**
  `cors()` is called with no origin restrictions (`Access-Control-Allow-Origin: *`). Restrict to the frontend origin. _(depends: 6.1 — must know the frontend URL)_
  _Ref: Audit M-16 | `relayer/modules/http-api.ts:36`_

### 5.3 Validation

- [ ] `[BLOCKER]` **Confirm Iris attestation relay works end-to-end on Sepolia**
  `iris-relay.ts` is implemented but only tested with MockCCTP. Perform a manual E2E test: shield from Base Sepolia, confirm the relayer polls Iris, receives attestation, and calls `relayWithHook` successfully. _(depends: 7.1 — contracts must be deployed first)_
  _Ref: `docs/SEPOLIA_DEPLOY.md` Step 3_

### 5.4 Explicitly Deferred

The following are tracked but do not block the Sepolia milestone:

- **H-6:** Cross-chain relayer fee deduction (requires contract changes + relayer Phase 4)
- **Relayer Phase 2:** Frontend integration (replace MetaMask signing with relayer submission)
- **Relayer Phase 3:** CCTP module extraction
- **Relayer Phase 4:** Cross-chain shield fee deduction (contract + relayer)
- **Relayer Phase 5:** Retry queue, deduplication, structured error codes

---

## 6. Frontend

### 6.1 Blockers

- [ ] `[BLOCKER]` **Verify Sepolia network config switches correctly**
  Confirm all four flows use correct RPC endpoints, deployment JSON filenames, and hookRouter addresses when `VITE_NETWORK=sepolia`.
  _Ref: `usdc-v2-frontend/src/config/networkConfig.ts` | `docs/SEPOLIA_DEPLOY.md` Step 2_

- [ ] `[BLOCKER]` **Confirm `VITE_RELAYER_URL` is wired correctly for Sepolia**
  Ensure the hosted relayer URL is documented and set in `.env.local`. If relayer is on a remote server, CORS must also be updated. _(depends: 5.2)_
  _Ref: `usdc-v2-frontend/src/config/networkConfig.ts`_

### 6.2 Should Fix

- [ ] `[SHOULD]` **Connect fee display to relayer `/fees` API**
  Fee estimate currently uses local `eth_estimateGas`. Wire up the relayer fee (portion the relayer charges) from the `/fees` endpoint before the demo.
  _Ref: `usdc-v2-frontend/src/services/deposit/evmFeeEstimatorService.ts`_

### 6.3 Validation

- [ ] `[BLOCKER]` **Manually test all four core flows from the frontend on Sepolia**
  _(depends: 7.1, 5.3 — contracts deployed, relayer running)_
  1. Hub shield (Ethereum Sepolia → privacy pool)
  2. Cross-chain shield (Base Sepolia → hub)
  3. Cross-chain unshield (hub → Base Sepolia)
  4. Private transfer (hub → hub, different shielded address)
  _Ref: `docs/SEPOLIA_DEPLOY.md`_

### 6.4 Out of Scope

- Frontend rewrite (confirmed temporary)
- Namada/Noble/Cosmos code path cleanup (legacy, harmless)
- localStorage encryption
- Transaction history export

---

## 7. Deployment & Infrastructure

### 7.1 Blockers

- [ ] `[BLOCKER]` **Run Aderyn static analysis and triage findings**
  Aderyn was skipped during the audit (Rust not installed). Install with `rustup default stable && cargo install aderyn`, run, and triage. Any new critical/high findings must be resolved before deploy.
  _Ref: `reports/static-analysis-summary.md`_

- [ ] `[BLOCKER]` **Deploy to Sepolia from clean state**
  Re-run `npm run setup:sepolia` after all contract fixes. Verify all four phases complete and deployment JSONs contain all expected addresses. Pay attention to Phase 3 (governance/crowdfund) and Phase 4 (cross-chain linking) since those contracts changed in recent PRs.
  _(depends: all Section 1-4 blocker fixes)_
  _Ref: `docs/SEPOLIA_DEPLOY.md` | CLAUDE.md Deployment Order_

- [ ] `[BLOCKER]` **Run full smoke test suite against Sepolia**
  Execute `npm run test:sepolia` with all flags: `--check`, `--shield`, `--cross-chain`. All must pass.
  _(depends: 7.1 deploy)_
  _Ref: `docs/SEPOLIA_DEPLOY.md` Step 5_

- [ ] `[BLOCKER]` **Confirm `testingMode=false` and `VERIFICATION_BYPASS` unreachable on deployed contracts**
  After deploy, call `pool.testingMode()` and confirm `false`. Attempt a call with `tx.origin == 0xdead` and confirm it fails. Add this check to the smoke test.
  _(depends: 1.1 C-1/C-2 fix, 7.1 deploy)_

### 7.2 Should Fix

- [ ] `[SHOULD]` **Verify Railgun SDK LevelDB doesn't load stale data**
  `VITE_NETWORK=sepolia` must be set to prevent QuickSync from loading wrong commitments. Confirm the relayer also initializes the SDK correctly. Delete `data/railgun-db/` if stale.
  _Ref: `docs/SEPOLIA_DEPLOY.md` Troubleshooting_

- [ ] `[SHOULD]` **Document secrets management process**
  `config/secrets.env` is gitignored. Document: who holds the deployer key, how to rotate it, how to fund the deployer address on each chain.
  _Ref: CLAUDE.md Environment & Secrets_

- [ ] `[SHOULD]` **Add cross-contract invariant tests for TreasuryGov and ARM supply**
  No invariant test confirms `ArmadaTreasuryGov` balance consistency or that ARM `totalSupply` stays constant post-distribution.
  _Ref: `reports/cross-contract-invariants.md` Gap #2_

---

## 8. Dependency Graph

### Critical Path to Sepolia Deploy

Items on the same level can proceed in parallel.

```
Level 0 — No dependencies, start immediately:
├── Privacy Pool: C-1/C-2, H-1/H-2, H-5
├── Yield: H-4
├── Governance: #4, #23, #29, H-8
├── Governance verify: #16, #17
├── Crowdfund: H-10
├── Relayer: C-4
├── Infra: Aderyn static analysis
│
Level 1 — Depends on Level 0 contract fixes:
├── Governance #19 regression test (depends: #25 confirmed)
├── Governance test coverage (depends: #4, #22 fixes)
├── Crowdfund test coverage (depends: H-10 fix)
├── Privacy Pool USDC balance invariant test
├── Aderyn triage (depends: Aderyn run)
│
Level 2 — Depends on Level 0-1:
├── Sepolia deployment (npm run setup:sepolia)
├── Frontend Sepolia config verification
│
Level 3 — Depends on Level 2:
├── Smoke tests (npm run test:sepolia)
├── testingMode=false confirmation
├── Iris relay E2E test
├── Frontend: all four core flows
├── CORS + relayer URL consistency
```

### Key Dependency Notes

- **H-11 (pool owner behind timelock):** If pursued, must be configured BEFORE deploying governance contracts — pool owner is set at initialization
- **C-1/C-2** directly gates the Level 3 smoke test confirming testingMode=false
- **M-16 (CORS)** should be done before the frontend Sepolia URL is wired — allowed origin must match
- **Aderyn** should run at Level 0 in parallel with contract fixes; triage at Level 1 since it may surface new blockers

---

## 9. Definition of Done

The Sepolia milestone is complete when ALL of the following are true:

### Contracts
- [ ] All `[BLOCKER]` items in Sections 1–4 are resolved and committed
- [ ] `npm run test:all` passes (Hardhat integration tests)
- [ ] `npm run test:forge` passes (Foundry fuzz/invariant tests)
- [ ] Aderyn has been run; all critical/high findings triaged (fixed or documented with justification)
- [ ] `testingMode` is `false` on deployed PrivacyPool (verified on-chain)
- [ ] `VERIFICATION_BYPASS` is confirmed unreachable on deployed contracts

### Governance
- [ ] All seven governance fixes (#4, #16 verify, #17 verify, #19 regression, #23, #29, H-8) are resolved
- [ ] Each fix has a targeted regression test that passes

### Relayer
- [ ] Relayer starts without errors on Sepolia config
- [ ] Startup assertion: `DEPLOYER_PRIVATE_KEY` required before binding port
- [ ] Iris attestation relay processes at least one real CCTP message

### Frontend
- [ ] All four core flows complete successfully on Sepolia:
  1. Hub shield (Ethereum Sepolia)
  2. Cross-chain shield (Base Sepolia → hub)
  3. Cross-chain unshield (hub → Base Sepolia)
  4. Private transfer (hub → hub)

### Deployment
- [ ] `npm run setup:sepolia` completes cleanly from fresh state
- [ ] Deployment manifests committed and up to date in `deployments/`
- [ ] `npm run test:sepolia` passes all three modes (`--check`, `--shield`, `--cross-chain`)

---

## Appendix: Additional Audit Findings (Tracked, Not Blocking)

These Medium/Low/Info findings from the audit are tracked here for completeness. None block Sepolia.

| ID | Finding | Status |
|----|---------|--------|
| M-2 | Fee bypass asymmetry (shield checks caller, unshield checks recipient) | Tracked |
| M-3 | Non-standard ERC-4626 with misleading function names | Accepted by design |
| M-5 | Self-call reentrancy in delegatecall pattern | Tracked |
| M-6 | Quorum live balance (partially addressed by #25 snapshot fix) | Tracked |
| M-8 | `recordFee()` / `onTokenTransfer()` no access control | Tracked |
| M-9 | Steward action delay retroactivity | Tracked |
| M-10 | Pending steward actions survive election | Fixed (#38) |
| M-11 | Mixed encoding in CCTP (encodePacked outer, encode inner) | Tracked |
| M-12 | Cost basis corruption via ERC20 transfer of vault shares | Related to H-4 |
| M-13 | Treasury as single point of failure for redemptions | Tracked |
| M-14 | `uint120` truncation without explicit checks | Tracked |
| M-15 | Adapter reads amount from calldata, not actual balance | Tracked |
| M-18 | Phase.Commitment enum defined but never set (dead code) | Tracked |
| H-7 | VERIFICATION_BYPASS runs after proof verification | Addressed with C-1/C-2 |
| H-9 | Abstain votes count toward quorum (undocumented) | Tracked |
| Low/Info | 23 additional low/informational findings | See `audit-reports/00-consolidated-summary.md` |

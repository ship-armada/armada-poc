# Consolidated Security Audit Summary: Railgun CCTP POC

**Date**: 2026-02-19
**Auditor**: Claude Opus 4.6 via Trail of Bits Skills
**Branch**: `trailofbits-audit` (commit `b56dc64`)
**Scope**: All Solidity contracts in `contracts/` (~7,471 SLOC across 46 contracts), plus TypeScript relayer service

---

## Methodology

This audit used 10 Trail of Bits skills systematically across 5 phases:

| Phase | Skill | Report |
|-------|-------|--------|
| 1a | `/entry-points` — Attack surface mapping | [01-entry-points.md](01-entry-points.md) |
| 1b | `/audit-context-building` — Architectural context | [02-audit-context.md](02-audit-context.md) |
| 2a | `/semgrep` — Static analysis (Decurity rules) | [04-semgrep-scan.md](04-semgrep-scan.md) |
| 2b | `/insecure-defaults` — Hardcoded secrets, fail-open | [03-insecure-defaults.md](03-insecure-defaults.md) |
| 3 | `/spec-compliance` — Spec-to-code divergences | [05-spec-compliance.md](05-spec-compliance.md) |
| 4a | `/function-analyzer` — 6 critical functions | [06-function-analysis.md](06-function-analysis.md) |
| 4b | `/sharp-edges` — API footgun analysis | [07-sharp-edges.md](07-sharp-edges.md) |
| 4c | `/token-integration-analyzer` — USDC/ayUSDC safety | [08-token-integration.md](08-token-integration.md) |
| 5a | `/code-maturity-assessor` — 9-category scorecard | [09-code-maturity.md](09-code-maturity.md) |
| 5b | `/property-based-testing` — Foundry invariant tests | [10-property-tests.md](10-property-tests.md) |

---

## Executive Summary

The Railgun CCTP POC demonstrates solid engineering for a proof-of-concept, with meaningful test coverage (10,248 SLOC tests, Halmos formal verification, Foundry invariant tests) and good NatSpec documentation. However, several **production-blocking** issues were identified across multiple analysis passes.

### Attack Surface

- **75 state-changing entry points** across 18 contracts
- **22 public (unrestricted)** functions — the primary attack surface
- **33 admin/owner-restricted**, **7 contract-only** integration points

### Code Maturity: MODERATE (2.1/4.0 average)

| Category | Rating |
|----------|--------|
| Arithmetic | Moderate |
| Auditing & Logging | Moderate |
| Access Controls | Moderate |
| Complexity | Moderate |
| Decentralization | **Weak** |
| Documentation | Satisfactory |
| MEV / Tx Ordering | Moderate |
| Low-Level Code | Moderate |
| Testing | Satisfactory |

---

## Findings Summary

### By Severity

| Severity | Count | Sources |
|----------|-------|---------|
| **CRITICAL** | 4 | Spec compliance, insecure defaults, code maturity |
| **HIGH** | 12 | Spec compliance, sharp edges, audit context, insecure defaults |
| **MEDIUM** | 18 | All reports |
| **LOW** | 15 | All reports |
| **INFO** | 8 | Token integration, semgrep |
| **Total** | **57** | |

### By Subsystem

| Subsystem | Critical | High | Medium | Low |
|-----------|----------|------|--------|-----|
| Privacy Pool | 2 | 4 | 5 | 4 |
| Cross-Chain (CCTP) | 0 | 2 | 3 | 1 |
| Yield System | 0 | 3 | 5 | 3 |
| Governance | 0 | 1 | 3 | 3 |
| Crowdfund | 0 | 1 | 2 | 3 |
| Infrastructure/Relayer | 2 | 1 | 0 | 1 |

---

## CRITICAL Findings (4)

### C-1: `setTestingMode(bool)` — Complete SNARK Proof Bypass
**Source**: Insecure defaults (03), Code maturity (09), Audit context (02)
**Location**: `PrivacyPool.sol:291-298`, `VerifierModule.sol:67`

Owner can disable ALL SNARK verification at any time via `setTestingMode(true)`. This allows arbitrary transaction forgery — creating commitments without valid proofs, spending without valid nullifier proofs. No compile-time or deployment-time restriction. Labeled "POC ONLY" but present in deployable code.

**Impact**: Total loss of privacy pool integrity. Any shielded funds can be stolen.
**Recommendation**: Remove entirely for production. Use a compile-time flag or deploy separate test/production contracts.

---

### C-2: `VERIFICATION_BYPASS` at `tx.origin == 0xdead`
**Source**: Insecure defaults (03), Code maturity (09), Spec compliance (05)
**Location**: `PrivacyPool.sol:378`, `VerifierModule.sol:106`, `Globals.sol:10`

Both `verify()` implementations return `true` when `tx.origin == address(0xdead)`. While `0xdead` is a burn address with no known private key, this creates a permanent backdoor that cannot be disabled. If `eth_estimateGas` results are trusted for verification decisions (some frontends do this), proofs could be bypassed.

**Impact**: Potential proof bypass in gas estimation contexts.
**Recommendation**: Remove entirely. Use a separate gas estimation function that doesn't touch proof verification.

---

### C-3: Shield Fee Formula Mismatch (Spec vs Code)
**Source**: Spec compliance (05) — FINDING-01
**Location**: `ShieldModule.sol:263-266`

The spec documents an additive/exclusive fee model: `base = amount * 10000 / (10000 + feeBps)`. The code implements a multiplicative/inclusive model: `base = amount - (amount * feeBps) / 10000`. At 50 bps the numerical difference is negligible (~0.0025%), but at higher fee rates the code systematically overcharges compared to the spec. This is a spec-code divergence with financial impact.

**Impact**: Users overcharged at higher fee rates vs documented behavior.
**Recommendation**: Align code and spec. The multiplicative model is simpler and standard; update the spec.

---

### C-4: Hardcoded Private Keys in Production-Reachable Config
**Source**: Insecure defaults (03)
**Location**: `relayer/config.ts:63-75`

Three Anvil private keys are hardcoded in the relayer config file. While these are well-known Anvil/Hardhat default keys, the config file is imported by production-reachable relayer code. If deployed without overriding, funds controlled by these keys would be immediately compromisable.

**Impact**: Complete fund loss if deployed with default keys.
**Recommendation**: Use environment variables with fail-secure (crash on missing) pattern.

---

## HIGH Findings (12)

| ID | Finding | Location | Source |
|----|---------|----------|--------|
| H-1 | Hub does not validate `remoteDomain` on cross-chain shields | `PrivacyPool.sol:161-208` | Audit context, Spec compliance, Semgrep |
| H-2 | Hub does not validate `sender` parameter (remote contract identity) | `PrivacyPool.sol:174-177` | Semgrep TP-2, Function analysis |
| H-3 | Modules callable directly, bypassing router (no `onlyDelegatecall` guard) | `ShieldModule.sol`, `TransactModule.sol`, `MerkleModule.sol` | Sharp edges |
| H-4 | Cost basis corruption across users via shared adapter identity | `ArmadaYieldVault.sol:212` | Sharp edges, Function analysis |
| H-5 | Front-running `initialize()` between deploy and init | `PrivacyPool.sol`, `PrivacyPoolClient.sol` | Sharp edges |
| H-6 | Cross-chain relayer fee deduction entirely unimplemented | Spec DOC-1 Phase 4 | Spec compliance |
| H-7 | `VERIFICATION_BYPASS` runs AFTER proof verification (accepts invalid proofs for gas estimation) | `PrivacyPool.sol:378` | Spec compliance |
| H-8 | Proposal threshold uses `totalSupply` not eligible supply (2.86x higher than intended) | `ArmadaGovernor.sol:162` | Spec compliance |
| H-9 | Abstain votes count toward quorum (undocumented behavior) | `ArmadaGovernor.sol:330` | Spec compliance |
| H-10 | ARM tokens permanently locked after crowdfund cancellation | `ArmadaCrowdfund.sol:372` | Spec compliance, Audit context |
| H-11 | Privacy pool owner not governed by timelock — can instantly change fees, disable proofs | `PrivacyPool.sol` | Code maturity |
| H-12 | No ReentrancyGuard on privacy pool modules (ShieldModule, TransactModule) | `ShieldModule.sol`, `TransactModule.sol` | Code maturity |

---

## MEDIUM Findings (18)

| ID | Finding | Location |
|----|---------|----------|
| M-1 | `safeApprove` without reset in `_executeCCTPBurn` | `TransactModule.sol:200` |
| M-2 | Fee bypass asymmetry: shield checks caller, unshield checks recipient | `ShieldModule.sol:218`, `TransactModule.sol:347` |
| M-3 | Non-standard ERC4626 with misleading function names | `ArmadaYieldVault.sol` |
| M-4 | First depositor inflation attack (no virtual shares) | `ArmadaYieldVault.sol:382-393` |
| M-5 | Self-call reentrancy in delegatecall→call→delegatecall pattern | Module architecture |
| M-6 | Quorum uses live treasury balance (not snapshot), manipulable during voting | `ArmadaGovernor.sol` |
| M-7 | No finalization deadline in crowdfund — admin can lock USDC indefinitely | `ArmadaCrowdfund.sol` |
| M-8 | `recordFee()` / `onTokenTransfer()` no access control | `ArmadaTreasury.sol:105` |
| M-9 | Steward action delay retroactivity (affects pending actions) | `TreasurySteward.sol` |
| M-10 | Pending steward actions survive election | `TreasurySteward.sol` |
| M-11 | Mixed encoding (abi.encodePacked outer, abi.encode inner) in CCTP | CCTP pipeline |
| M-12 | Cost basis corruption via ERC20 transfer of vault shares | `ArmadaYieldVault.sol` |
| M-13 | Treasury as single point of failure for redemptions | `ArmadaYieldVault.sol:287` |
| M-14 | `uint120` truncation without explicit checks (4 locations) | Adapter, Client |
| M-15 | Adapter reads amount from calldata, not actual balance | `ArmadaYieldAdapter.sol:193` |
| M-16 | CORS wide open on relayer HTTP API | `relayer/modules/http-api.ts:36` |
| M-17 | Share price rounding on dust deposits (found by fuzzer) | `ArmadaYieldVault.sol` |
| M-18 | Phase.Commitment enum defined but never set (dead code) | `ArmadaCrowdfund.sol` |

---

## Token Integration Assessment

**Overall Risk**: LOW-MEDIUM (for USDC-only POC)

| Pattern | Status |
|---------|--------|
| SafeERC20 usage | Consistent across all 6 key contracts |
| Fee-on-transfer defense | ShieldModule uses balance-before/after pattern |
| Approval race conditions | Mixed: Client resets to 0, TransactModule does not |
| Rebasing token safety | N/A (USDC is non-rebasing) |
| ayUSDC ERC20 conformity | Fully compliant (inherits OpenZeppelin ERC20) |
| ReentrancyGuard | Present on adapter and vault; missing on privacy pool modules |

---

## Property-Based Testing Results

**New invariant tests written**: 25 tests across 4 test files
**All tests pass**: 84/84
**Coverage**: 17 invariants across privacy pool, yield, governance, and crowdfund

### Finding from Fuzzing

**F-1 (INV-Y3)**: ArmadaYieldVault share price can decrease by >1 bps on sub-dollar dust deposits after yield accrual. Standard ERC-4626 rounding behavior, but enables griefing via many dust deposits. **Recommendation**: Add $1 minimum deposit guard.

### Test Files Created

- `test-foundry/PrivacyPoolFullInvariant.t.sol` (5 invariants)
- `test-foundry/YieldFullInvariant.t.sol` (9 tests)
- `test-foundry/GovernorInvariant.t.sol` (5 invariants)
- `test-foundry/CrowdfundFullInvariant.t.sol` (6 invariants)

---

## Remediation Priority

### P0 — Must Fix Before Any Deployment (4 items)

1. **Remove `testingMode`** — Replace with compile-time or deployment-time flag
2. **Remove `VERIFICATION_BYPASS`** — Create separate gas estimation path
3. **Add remoteDomain + sender validation** on Hub's `handleReceiveFinalizedMessage`
4. **Move private keys to environment variables** with fail-secure pattern

### P1 — Should Fix Before Production (8 items)

1. Add `onlyDelegatecall` guard to all modules (ShieldModule, TransactModule, MerkleModule)
2. Add ReentrancyGuard to privacy pool modules
3. Use OpenZeppelin Initializable with `_disableInitializers()` in constructors
4. Fix proposal threshold to use eligible supply, not total supply
5. Add ARM recovery mechanism for canceled crowdfund
6. Address cost basis corruption in yield vault (override `_transfer` or restrict transfers)
7. Put privacy pool owner behind timelock
8. Fix `safeApprove` in TransactModule to reset to 0 first

### P2 — Should Fix Before Production (5 items)

1. Add virtual shares/assets offset to ArmadaYieldVault
2. Add minimum deposit guard ($1 USDC) to vault
3. Add finalization deadline to crowdfund
4. Add rate limiting and CORS restrictions to relayer API
5. Implement cross-chain relayer fee deduction per spec

### P3 — Should Address (5 items)

1. Add `SafeCast.toUint120()` for all narrowing casts
2. Remove Phase.Commitment dead code
3. Add monitoring/alerting infrastructure
4. Set up CI/CD pipeline
5. Align spec and code on fee formula

---

## Files Delivered

| File | Description |
|------|-------------|
| `audit-reports/00-consolidated-summary.md` | This document |
| `audit-reports/01-entry-points.md` | Attack surface map (75 entry points) |
| `audit-reports/02-audit-context.md` | Architectural context, trust boundaries, invariants |
| `audit-reports/03-insecure-defaults.md` | 14 insecure default findings |
| `audit-reports/04-semgrep-scan.md` | Semgrep scan: 30 findings, 2 true positives |
| `audit-reports/05-spec-compliance.md` | Spec-to-code compliance: 30 findings (82/100) |
| `audit-reports/06-function-analysis.md` | Deep analysis of 6 critical functions |
| `audit-reports/07-sharp-edges.md` | 26 API footgun findings |
| `audit-reports/08-token-integration.md` | USDC/ayUSDC token integration safety |
| `audit-reports/09-code-maturity.md` | 9-category maturity scorecard |
| `audit-reports/10-property-tests.md` | Property-based test design + results |
| `test-foundry/PrivacyPoolFullInvariant.t.sol` | Privacy pool invariant tests |
| `test-foundry/YieldFullInvariant.t.sol` | Yield system invariant tests |
| `test-foundry/GovernorInvariant.t.sol` | Governance invariant tests |
| `test-foundry/CrowdfundFullInvariant.t.sol` | Crowdfund invariant tests |
| `semgrep-results-001/` | Raw Semgrep scan results (JSON + SARIF) |

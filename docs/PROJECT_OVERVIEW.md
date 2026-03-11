# Armada Project Overview

## What Is Armada?

Armada is a **cross-chain privacy protocol for USDC** that combines three core capabilities:

1. **ZK-Shielded Pool** — Users deposit USDC into a privacy pool powered by Groth16 SNARKs (adapted from Railgun). Once shielded, transfers and withdrawals are private — no one can link sender to recipient.
2. **Cross-Chain Bridging via CCTP V2** — Circle's Cross-Chain Transfer Protocol enables USDC to move between chains natively. Users can shield on one chain and unshield on another without ever revealing their identity.
3. **Shielded Yield** — Pooled shielded USDC is deposited into Aave V4, and yield accrues back to the shielded pool. Users earn yield without revealing their balance or identity.

The architecture is **hub-and-spoke**: a Hub chain holds the full privacy pool, yield contracts, governance, and crowdfund. Lightweight `PrivacyPoolClient` contracts on Client chains handle local shielding/unshielding and bridge to the Hub via CCTP.

```
Client Chain A                Hub Chain                    Client Chain B
┌──────────────┐         ┌──────────────────┐         ┌──────────────┐
│ Privacy      │  CCTP   │ PrivacyPool      │  CCTP   │ Privacy      │
│ PoolClient   │ ──────► │  + ShieldModule  │ ◄────── │ PoolClient   │
│              │         │  + TransactModule│         │              │
└──────────────┘         │  + MerkleModule  │         └──────────────┘
                         │  + VerifierModule│
                         │ YieldVault (Aave)│
                         │ Governance (ARM) │
                         │ Crowdfund        │
                         └──────────────────┘
```

---

## Current Project Status

**Stage: POC transitioning to production.** The core protocol works end-to-end on local Anvil chains and Sepolia testnet. Code quality expectations are rising — no new shortcuts, but legacy POC-era shortcuts are tracked.

### What's Working

| Component | Status | Notes |
|-----------|--------|-------|
| Privacy Pool (shield/transfer/unshield) | Working | Railgun-based, Groth16 proofs |
| Cross-chain bridging (CCTP V2) | Working | Mock (local) + real (Sepolia via Iris) |
| Shielded Yield (Aave integration) | Working | MockAaveSpoke locally, real Aave on testnet |
| Governance (ARM token + proposals) | Working | Typed proposals, per-type quorum, timelock |
| Crowdfund (word-of-mouth whitelist) | Working | Multi-hop invites, elastic expansion, pro-rata allocation |
| Relayer (HTTP API) | Working | Fee quotes, transaction relay, CCTP message forwarding |
| Frontend (demo UI) | Working | Temporary React app for testing flows |
| Crowdfund UI | Working | Standalone testing interface |
| Sepolia testnet deployment | Working | Full deployment with real CCTP attestation |

### Known POC Shortcuts (Tracked, Will Be Fixed)

- `setTestingMode()` bypasses ZK proof verification entirely
- `VERIFICATION_BYPASS` at `tx.origin == 0xdead` in Snark.sol
- Hardcoded Anvil private keys in relayer config
- Shield fee formula mismatch between contract and SDK

### Key Metrics

- **~46 contracts**, ~9,068 SLOC Solidity
- **~10,248 SLOC tests** across Hardhat, Foundry, and Halmos
- **57 audit findings** (4 Critical, 12 High, 18 Medium, 15 Low, 8 Info)
- **Code maturity: 2.1/4.0** (Moderate — good tests, architectural concerns remain)

---

## Security Audit Summary

An AI-assisted security audit (Trail of Bits methodology) was performed in February 2026. Key findings:

### Critical (P0 — Must Fix Before Any Deployment)

1. **Remove `setTestingMode()` and `VERIFICATION_BYPASS`** — Complete SNARK bypass; anyone can steal all funds
2. **Add cross-chain validation** — Hub's CCTP handler doesn't validate `remoteDomain` or `sender`; rogue chain can inject commitments
3. **Move private keys to env vars** — Hardcoded Anvil keys imported by production code paths

### High Priority (P1 — Before Production)

- Add `ReentrancyGuard` to privacy pool modules
- Fix proposal threshold (uses `totalSupply` not eligible supply — threshold is 2.86x too high)
- Implement cross-chain relayer fee deduction
- Fix cost basis corruption in yield vault (shared adapter identity)
- Put privacy pool owner behind timelock
- Fix `safeApprove` without reset in TransactModule
- ARM token recovery for canceled crowdfunds

### Medium Priority (P2)

- First depositor inflation attack (add virtual shares to vault)
- Quorum uses live treasury balance not snapshot
- No finalization deadline in crowdfund
- Share price rounding on dust deposits

---

## Testing Landscape

Armada has a multi-layered testing strategy:

### 1. Hardhat Integration Tests (`test/`, TypeScript/Mocha)

These are the primary integration tests. They require local Anvil chains running (`npm run chains`).

| Suite | What It Tests |
|-------|--------------|
| `privacy_pool_integration.ts` | Core shield/transfer/unshield flows |
| `privacy_pool_adversarial.ts` | Attack scenarios (frontrunning, reentrancy, replay) |
| `privacy_pool_hardening.ts` | Edge cases and boundary conditions |
| `shielded_yield_integration.ts` | Yield deposit/withdraw through privacy pool |
| `cross_contract_integration.ts` | Adapter and vault interactions |
| `governance_integration.ts` | Full proposal lifecycle (create → vote → queue → execute) |
| `governance_adversarial.ts` | Malicious voting, threshold manipulation |
| `governance_emergency_pause.ts` | Emergency pause with auto-expiry |
| `governance_param_updates.ts` | Governance-updatable parameters |
| `crowdfund_integration.ts` | Full crowdfund lifecycle (setup → invite → commit → finalize → claim) |
| `crowdfund_adversarial.ts` | Allocation edge cases, rollover paths |
| `yield_integration.ts` | Vault mechanics (deposit/withdraw/redeem, share pricing) |
| `gas_benchmark.ts` | Gas cost measurement for key operations |
| `full_lifecycle_demo.ts` | End-to-end multi-chain flows |

**Run:** `npm run test` (core) or `npm run test:all` (everything)

### 2. Foundry Fuzz & Invariant Tests (`test-foundry/`, Solidity)

These run offline (no Anvil needed) and use Foundry's fuzzing engine.

| Suite | What It Tests |
|-------|--------------|
| `PrivacyPoolFullInvariant.t.sol` | 5 invariants: nullifier uniqueness, commitment integrity, merkle safety |
| `PrivacyPoolBalanceInvariant.t.sol` | 6 invariants: USDC balance conservation across shield + unshield flows |
| `YieldFullInvariant.t.sol` | 9 tests: share price monotonicity, balance conservation, fee correctness |
| `GovernorInvariant.t.sol` | 5 invariants: voting power consistency, quorum safety |
| `CrowdfundFullInvariant.t.sol` | 6 invariants: allocation math, phase transitions, USDC conservation |
| Various fuzz tests | Boundary conditions, allocation math, merkle operations |
| `OnlyDelegatecall.t.sol` | Reentrancy protection via delegatecall guards |

**Run:** `npm run test:forge`

### 3. Halmos Symbolic Verification (`test-foundry/Halmos*.t.sol`)

Halmos performs symbolic execution to **prove** properties hold for all possible inputs, not just fuzzed samples.

- Allocation correctness proofs
- Checkpoint consistency
- Fee calculation bounds
- Specific property verification

**Run:** `npm run halmos`

### 4. Coverage Gaps

Per the crowdfund test scenarios document, **87 of 234 scenarios are covered** (~37%). Major gaps:

- Rollover logic reachability (some allocation paths may be unreachable)
- Incremental admin withdrawals across phases
- Allocation precision at extreme values
- Event emission verification
- Timestamp boundary conditions

### Running Tests

```bash
npm run test              # Core privacy pool integration
npm run test:all          # All Hardhat integration tests
npm run test:governance   # Governance-specific tests
npm run test:crowdfund    # Crowdfund-specific tests
npm run test:forge        # All Foundry fuzz/invariant tests
npm run halmos            # Symbolic verification
```

**Prerequisites:** `npm run chains` must be running for Hardhat tests. Foundry/Halmos tests run offline.

---

## What to Work On Next

### Tier 1: Audit Remediation (Highest Impact)

These are the P0/P1 findings from the security audit. Each is well-scoped and independently addressable:

1. **Remove verification bypasses** — Replace `setTestingMode()` and `VERIFICATION_BYPASS` with compile-time or deployment-time flags. This is the single most important security fix.
2. **Add CCTP validation** — Validate `remoteDomain` and `sender` in the hub's cross-chain message handler. Prevents rogue chain injection.
3. **Add ReentrancyGuard** — Apply to all privacy pool module external functions.
4. **Fix proposal threshold** — Change from `totalSupply` to eligible supply (exclude treasury + crowdfund addresses).
5. **Fix `safeApprove` without reset** — In TransactModule, reset approval to 0 before setting new approval.

### Tier 2: Test Coverage Expansion

The testing infrastructure is strong but has documented gaps. These are ideal for agent-assisted development:

- **147 uncovered crowdfund scenarios** — The test plan (`docs/CROWDFUND_TEST_SCENARIOS.md`) has a detailed checklist. An agent can systematically write tests for each gap.
- **Governance test gaps** — `docs/governance-test-scenarios.md` tracks 223 scenarios with coverage status.
- **Property-based testing expansion** — Add more Foundry invariant tests for edge cases found in the audit.

### Tier 3: Relayer Completion

The relayer implementation plan (`docs/RELAYER_IMPLEMENTATION_PLAN.md`) has 5 phases. Phase 1 (HTTP API) is partially done. Remaining:

- **Phase 2:** Frontend integration (replace MetaMask signing with relayer submission)
- **Phase 3:** CCTP module extraction into modular component
- **Phase 4:** Cross-chain shield fee deduction (contract + relayer changes)
- **Phase 5:** Retry queue, deduplication, structured error codes

### Tier 4: New Features

- **Governance activation flow** — Wire crowdfund completion to governance activation (`docs/GOVERNANCE_ACTIVATION.md`)
- **ARM token recovery** — Handle canceled crowdfund ARM redistribution
- **Vault hardening** — Virtual shares offset for first-depositor protection, minimum deposit guard

---

## Using Agents for Development

This codebase is well-suited for agent-assisted development. Here's how to leverage agents effectively:

### Best Agent Tasks

1. **Test writing** — Point an agent at a test scenario document and have it systematically write tests. The scenario docs (`docs/CROWDFUND_TEST_SCENARIOS.md`, `docs/governance-test-scenarios.md`) are structured as checklists, making them ideal agent inputs.

2. **Audit remediation** — Each audit finding is self-contained with a description, location, and recommended fix. An agent can implement fixes one at a time and verify with existing tests.

3. **Code review and security analysis** — Agents can review PRs against the audit findings and known patterns.

4. **Documentation updates** — After code changes, agents can update CLAUDE.md, architecture notes, and test scenario docs.

### Agent Workflow Tips

- **Always run tests after changes:** `npm run test:all && npm run test:forge` catches most regressions
- **Don't touch `contracts/railgun/logic/`** — Changes silently break ZK circuits
- **Use `--legacy-peer-deps`** for any npm operations
- **Delete `data/railgun-db/`** if shield/transact operations fail after redeploying
- **Check deployment order** if adding new contracts — see CLAUDE.md for the required sequence

### MCP Server

The project includes an MCP server (`mcp-server/`) that exposes read-only development tools for AI agents. This provides structured access to contract analysis, deployment status, and test results.

---

## Roadmap: Technical

```
NOW ─────────────────────────────────────────────────────────────► PRODUCTION

Phase 1: Hardening (Current)
├── P0 audit fixes (verification bypass removal, CCTP validation)
├── P1 audit fixes (reentrancy guards, threshold fix, timelock)
├── Test coverage expansion (147 crowdfund + governance gaps)
└── Relayer Phase 2-3 (frontend integration, modular CCTP)

Phase 2: Feature Completion
├── Cross-chain shield fee deduction (Relayer Phase 4)
├── Governance activation flow (crowdfund → governance pipeline)
├── ARM token recovery for canceled crowdfunds
├── Vault hardening (virtual shares, minimum deposit)
└── Relayer Phase 5 (retry queue, error handling)

Phase 3: Production Preparation
├── Replace Railgun circuits with custom circuits
├── Deep CCTP integration (CCTP-aware commitments)
├── Professional security audit
├── Mainnet deployment preparation
└── Frontend replacement (current UI is temporary)

Phase 4: Future Vision
├── Convert circuit for yield (prove share of pool yield privately)
├── Cross-chain MASP (hub model first, then mesh)
├── Nullifier synchronization across chains
└── Merkle root attestation broadcasting via CCTP
```

## Roadmap: Non-Technical

```
NOW ─────────────────────────────────────────────────────────────► LAUNCH

Community & Governance
├── Crowdfund parameter finalization (hop caps, elastic triggers)
├── ARM token distribution strategy
├── Governance parameter tuning (quorum, voting periods, delays)
├── Steward role definition and budget allocation
└── Community documentation and onboarding materials

Security & Compliance
├── Professional audit engagement (Trail of Bits, OpenZeppelin, etc.)
├── Bug bounty program design
├── Regulatory analysis for shielded pool operations
├── Compliance framework for relayer operators
└── Privacy policy and terms of service

Operations
├── Relayer operator incentive model
├── Monitoring and alerting infrastructure
├── Incident response procedures (emergency pause tested)
├── Multi-sig setup for governance deployment
└── Testnet → mainnet migration plan

Product
├── User research on privacy needs and UX expectations
├── Production frontend design and development
├── Mobile wallet integration strategy
├── SDK/API for third-party integrations
└── Documentation site (user-facing)
```

---

## Key Files Reference

| Purpose | File |
|---------|------|
| Project instructions | `CLAUDE.md` |
| Architecture vision | `.claude/ARCHITECTURE_NOTES.md` |
| Audit findings | `audit-reports/00-consolidated-summary.md` |
| Relayer plan | `docs/RELAYER_IMPLEMENTATION_PLAN.md` |
| Governance activation | `docs/GOVERNANCE_ACTIVATION.md` |
| Crowdfund test gaps | `docs/CROWDFUND_TEST_SCENARIOS.md` |
| Governance test gaps | `docs/governance-test-scenarios.md` |
| Sepolia deployment | `docs/SEPOLIA_DEPLOY.md` |
| Aave mock design | `docs/AAVE_V4_LOCAL_MOCKUP_PLAN.md` |
| Key derivation spec | `docs/WEB_KEY_DERIVATION.md` |
| Local config | `config/local.env` |
| Deployment manifests | `deployments/*.json` |

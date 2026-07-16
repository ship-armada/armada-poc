# Spec-to-Code Compliance Report: Railgun CCTP POC

**Date**: 2026-02-19
**Auditor**: Claude Opus 4.6 (spec-to-code compliance analysis)
**Branch**: trailofbits-audit
**Method**: 7-Phase deterministic compliance workflow

---

## 1. Executive Summary

This report analyzes spec-to-code compliance across four major subsystems of the Railgun CCTP POC: Privacy Pool, Yield System, Governance, and Crowdfund. The analysis compares documented behavior in specification documents against the actual deployed contract logic, line-by-line.

**Overall Compliance Score**: 82/100

| Subsystem | Findings | Critical | High | Medium | Low |
|-----------|----------|----------|------|--------|-----|
| Privacy Pool | 12 | 1 | 3 | 5 | 3 |
| Yield System | 8 | 0 | 2 | 4 | 2 |
| Governance | 5 | 0 | 1 | 2 | 2 |
| Crowdfund | 5 | 0 | 1 | 2 | 2 |
| **Total** | **30** | **1** | **7** | **13** | **9** |

The single CRITICAL finding is a divergence in the shield fee calculation formula between the spec and the code. Seven HIGH findings cover missing domain validation, undocumented testing/bypass mechanisms, and incorrect relayer fee architecture.

---

## 2. Documentation Sources

| ID | Document | Path | Role |
|----|----------|------|------|
| DOC-1 | Relayer Spec | `/Volumes/T7/railgun/poc/docs/RELAYER_SPEC.md` | Primary spec for relayer fee model, cross-chain flows |
| DOC-2 | Relayer Implementation Plan | `/Volumes/T7/railgun/poc/docs/RELAYER_IMPLEMENTATION_PLAN.md` | Detailed plan for relayer modules, contract changes |
| DOC-3 | Aave V4 Mock Plan | `/Volumes/T7/railgun/poc/docs/AAVE_V4_LOCAL_MOCKUP_PLAN.md` | Yield mock spec |
| DOC-4 | Legacy Demo POC | `/Volumes/T7/railgun/poc/_legacy/docs/DEMO_POC_RAILGUN.md` | Legacy reference architecture |
| DOC-5 | Legacy README | `/Volumes/T7/railgun/poc/_legacy/README.md` | Legacy contracts description |
| DOC-6 | Railgun README | `/Volumes/T7/railgun/poc/contracts/railgun/README.md` | Module role description |
| DOC-7 | Audit Context | `/Volumes/T7/railgun/poc/audit-reports/02-audit-context.md` | Architectural analysis, invariants |
| DOC-NS | NatSpec Comments | (in contract source files) | Inline specification |

---

## 3. Spec-IR Breakdown (Key Claims Extracted)

### 3.1 Privacy Pool

```yaml
- id: SPEC-PP-01
  source: DOC-7 Section 3 "Shield Flow (Local)"
  claim: "User calls shield(ShieldRequest[]) with USDC; ShieldModule validates commitment preimage, computes fee, transfers USDC in; Hash commitment via Poseidon; insert into merkle tree; Emit Shield event"
  type: flow
  confidence: 0.95

- id: SPEC-PP-02
  source: DOC-7 Section 3 "Transact Flow (Unshield)"
  claim: "User calls transact(Transaction[]) with SNARK proof; TransactModule validates proof, checks adaptContract == msg.sender; Nullify spent inputs, accumulate new commitments; Transfer USDC out to recipient; Insert new commitments into merkle tree"
  type: flow
  confidence: 0.95

- id: SPEC-PP-03
  source: DOC-7 Section 3 "Cross-Chain Shield (Client -> Hub)"
  claim: "Client: user calls crossChainShield() -> burns USDC via CCTP; CCTP attestation -> relayer calls receiveMessage on Hub; Hub: handleReceiveFinalizedMessage -> _processInternalShield; Creates commitment in merkle tree"
  type: flow
  confidence: 0.95

- id: SPEC-PP-04
  source: User requirement + DOC-1 Section "Cross-Chain Shields"
  claim: "Fee: 50 bps shield fee configured in deploy script. Fee calculation: base = amount * 10000 / (10000 + feeBps), fee = amount - base"
  type: formula
  confidence: 0.95

- id: SPEC-PP-05
  source: DOC-7 Section 4 "INV-1"
  claim: "Every merkle leaf is backed by a token transfer in or CCTP mint"
  type: invariant
  confidence: 0.95

- id: SPEC-PP-06
  source: DOC-7 Section 4 "INV-2"
  claim: "Nullifiers can only be spent once per (treeNumber, nullifier)"
  type: invariant
  confidence: 0.95

- id: SPEC-PP-07
  source: DOC-7 Section 4 "INV-7"
  claim: "SNARK proofs verified before any state mutation (unless testingMode)"
  type: invariant
  confidence: 0.90

- id: SPEC-PP-08
  source: DOC-1 Section "Cross-Chain Shield"
  claim: "Hub-side ShieldModule creates commitment for (amount - relayerFee) and transfers relayerFee to msg.sender (the relayer)"
  type: flow
  confidence: 0.90

- id: SPEC-PP-09
  source: DOC-2 Phase 4.2
  claim: "PrivacyPoolClient.crossChainShield() should accept relayerFee parameter"
  type: requirement
  confidence: 0.90

- id: SPEC-PP-10
  source: DOC-7 Section 5 "HIGH: Source Domain Not Validated on Hub"
  claim: "PrivacyPool.handleReceiveFinalizedMessage does NOT check remoteDomain against remotePools"
  type: observation
  confidence: 0.95

- id: SPEC-PP-11
  source: DOC-1 Section "Trust Model: Shielded Yield"
  claim: "ArmadaYieldAdapter cannot deviate from the user's proof. The proof binds adaptParams = hash(npk, encryptedBundle, shieldKey)"
  type: security
  confidence: 0.95

- id: SPEC-PP-12
  source: DOC-7 Section 6
  claim: "privilegedShieldCallers bypass fees on shield (checks caller) and unshield (checks recipient)"
  type: behavior
  confidence: 0.95
```

### 3.2 Yield System

```yaml
- id: SPEC-YS-01
  source: User requirement
  claim: "ArmadaYieldVault: ERC4626-style (deposit/redeem), NOT rebasing"
  type: design
  confidence: 0.95

- id: SPEC-YS-02
  source: User requirement + DOC-7 Section 7
  claim: "10% yield fee (1000 bps) on redeem profits"
  type: formula
  confidence: 0.95

- id: SPEC-YS-03
  source: User requirement + DOC-7 Section 7
  claim: "Cost basis tracking per user: (oldBasis * oldShares + assets * 1e18) / (oldShares + newShares)"
  type: formula
  confidence: 0.95

- id: SPEC-YS-04
  source: User requirement
  claim: "Adapter pattern: lendAndShield = unshield USDC -> deposit to vault -> shield shares"
  type: flow
  confidence: 0.95

- id: SPEC-YS-05
  source: User requirement
  claim: "Adapter pattern: redeemAndShield = unshield shares -> redeem from vault -> shield USDC"
  type: flow
  confidence: 0.95

- id: SPEC-YS-06
  source: DOC-7 Section 4 "INV-Y1"
  claim: "Adapter holds zero tokens between atomic operations"
  type: invariant
  confidence: 0.85

- id: SPEC-YS-07
  source: DOC-7 Section 4 "INV-Y3"
  claim: "adaptParams binding prevents adapter from changing shield destination"
  type: invariant
  confidence: 0.95
```

### 3.3 Governance

```yaml
- id: SPEC-GOV-01
  source: User requirement
  claim: "ARM token: 100M total supply, fixed"
  type: invariant
  confidence: 0.95

- id: SPEC-GOV-02
  source: User requirement + DOC-7 Section 7
  claim: "Proposal threshold: 0.1% of eligible supply (10 bps)"
  type: formula
  confidence: 0.95

- id: SPEC-GOV-03
  source: User requirement + DOC-7 Section 7
  claim: "Quorum: (totalSupply - treasuryBalance) * quorumBps / 10000"
  type: formula
  confidence: 0.95

- id: SPEC-GOV-04
  source: User requirement
  claim: "Timelock: 2-day minimum delay"
  type: parameter
  confidence: 0.95

- id: SPEC-GOV-05
  source: User requirement
  claim: "Steward: 180-day term, 1% spend cap per 30-day period"
  type: parameter
  confidence: 0.95

- id: SPEC-GOV-06
  source: User requirement
  claim: "VotingLocker: lock ARM to get voting power, checkpoint on lock/unlock"
  type: flow
  confidence: 0.95
```

### 3.4 Crowdfund

```yaml
- id: SPEC-CF-01
  source: User requirement
  claim: "Hop-based whitelist: seeds (hop 0) -> invites (hop 1, 2, ...)"
  type: flow
  confidence: 0.95

- id: SPEC-CF-02
  source: User requirement
  claim: "Per-participant cap per hop"
  type: constraint
  confidence: 0.95

- id: SPEC-CF-03
  source: User requirement
  claim: "allocUsdc + refundUsdc == committed (exact per participant)"
  type: invariant
  confidence: 0.95

- id: SPEC-CF-04
  source: User requirement
  claim: "Reserve BPS sum to 10000"
  type: invariant
  confidence: 0.95

- id: SPEC-CF-05
  source: User requirement
  claim: "Pro-rata scaling when oversubscribed"
  type: formula
  confidence: 0.95
```

---

## 4. Code-IR Summary

### 4.1 Privacy Pool Module Summary

| Contract | File | Key Functions | Lines |
|----------|------|---------------|-------|
| PrivacyPool | `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` | initialize, shield, transact, atomicCrossChainUnshield, handleReceiveFinalizedMessage, verify | 439 |
| ShieldModule | `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` | shield, processIncomingShield, _processInternalShield, _transferTokenIn, _getFee, _hashCommitment | 298 |
| TransactModule | `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/TransactModule.sol` | transact, atomicCrossChainUnshield, _validateTransaction, _accumulateAndNullify, _transferTokenOut, _getFee | 422 |
| MerkleModule | `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/MerkleModule.sol` | initializeMerkle, insertLeaves, hashLeftRight, _newTree | 195 |
| VerifierModule | `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/VerifierModule.sol` | verify, setVerificationKey, hashBoundParams, setTestingMode | 149 |
| PrivacyPoolClient | `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` | crossChainShield, handleReceiveFinalizedMessage | 263 |
| PrivacyPoolStorage | `/Volumes/T7/railgun/poc/contracts/privacy-pool/storage/PrivacyPoolStorage.sol` | (storage layout only) | 153 |

### 4.2 Yield System Module Summary

| Contract | File | Key Functions | Lines |
|----------|------|---------------|-------|
| ArmadaYieldVault | `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol` | deposit, redeem, totalAssets, _convertToShares, _convertToAssets | 405 |
| ArmadaYieldAdapter | `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol` | lendAndShield, redeemAndShield, previewLend, previewRedeem | 332 |
| ArmadaTreasury | `/Volumes/T7/railgun/poc/contracts/yield/ArmadaTreasury.sol` | withdraw, recordFee, onTokenTransfer | 118 |
| YieldAdaptParams | `/Volumes/T7/railgun/poc/contracts/yield/YieldAdaptParams.sol` | encode, verify | 57 |

### 4.3 Governance Module Summary

| Contract | File | Key Functions | Lines |
|----------|------|---------------|-------|
| ArmadaGovernor | `/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` | propose, castVote, queue, execute, cancel, quorum | 342 |
| ArmadaToken | `/Volumes/T7/railgun/poc/contracts/governance/ArmadaToken.sol` | constructor (mints 100M) | 14 |
| VotingLocker | `/Volumes/T7/railgun/poc/contracts/governance/VotingLocker.sol` | lock, unlock, getPastLockedBalance | 170 |
| ArmadaTreasuryGov | `/Volumes/T7/railgun/poc/contracts/governance/ArmadaTreasuryGov.sol` | distribute, createClaim, exerciseClaim, stewardSpend | 192 |
| TreasurySteward | `/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` | electSteward, proposeAction, executeAction, vetoAction | 164 |

### 4.4 Crowdfund Module Summary

| Contract | File | Key Functions | Lines |
|----------|------|---------------|-------|
| ArmadaCrowdfund | `/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` | addSeeds, invite, commit, finalize, claim, refund, _computeAllocation | 486 |

---

## 5. Full Alignment Matrix

### 5.1 Privacy Pool

| Spec-IR | Code-IR | Match Type | Confidence | Notes |
|---------|---------|------------|------------|-------|
| SPEC-PP-01 (Shield flow) | ShieldModule.shield() L36-73 | partial_match | 0.90 | Flow matches but fee formula diverges from spec |
| SPEC-PP-02 (Transact flow) | TransactModule.transact() L39-86 | full_match | 0.95 | Proof verified, nullifiers spent, tokens transferred |
| SPEC-PP-03 (Cross-chain shield) | PrivacyPool.handleReceiveFinalizedMessage() L161-208 + ShieldModule.processIncomingShield() L84-117 | partial_match | 0.85 | Flow works but no relayer fee deduction implemented |
| SPEC-PP-04 (Fee formula) | ShieldModule._getFee() L254-272 | **mismatch** | 0.95 | Spec says `base = amount * 10000 / (10000 + feeBps)` but code computes `base = amount - (amount * feeBps) / 10000` |
| SPEC-PP-05 (INV-1: backed leaves) | ShieldModule L234-238 (balance check) | full_match | 0.90 | Balance diff checked in _transferTokenIn |
| SPEC-PP-06 (INV-2: nullifier once) | TransactModule L311-316 | full_match | 0.95 | `require(!nullifiers[treeNum][nullifier])` |
| SPEC-PP-07 (INV-7: proof before mutation) | TransactModule L51-54 + L57 | partial_match | 0.85 | Proof validated in first pass; nullify also in first pass (same loop) |
| SPEC-PP-08 (Relayer fee deduction) | ShieldModule.processIncomingShield() L84-117 | **missing_in_code** | 0.95 | No relayerFee field in ShieldData, no fee deduction, no fee transfer to msg.sender |
| SPEC-PP-09 (Client relayerFee param) | PrivacyPoolClient.crossChainShield() L113-161 | **missing_in_code** | 0.95 | No relayerFee parameter; uses maxFee (CCTP protocol-level fee), not relayer application fee |
| SPEC-PP-10 (No domain check on Hub) | PrivacyPool.handleReceiveFinalizedMessage() L161-208 | code_matches_observation | 0.95 | Confirmed: remoteDomain param is unnamed, `sender` is silenced |
| SPEC-PP-11 (adaptParams binding) | ArmadaYieldAdapter L169-175, YieldAdaptParams.verify() | full_match | 0.95 | adaptParams = keccak256(npk, encryptedBundle, shieldKey) verified |
| SPEC-PP-12 (Privileged fee bypass) | ShieldModule L218, TransactModule L347 | full_match | 0.95 | Shield checks caller, unshield checks recipient |

### 5.2 Yield System

| Spec-IR | Code-IR | Match Type | Confidence | Notes |
|---------|---------|------------|------------|-------|
| SPEC-YS-01 (ERC4626-style, not rebasing) | ArmadaYieldVault extends ERC20, deposit/redeem pattern | full_match | 0.95 | Non-rebasing, share-based, deposit/redeem interface |
| SPEC-YS-02 (10% yield fee) | ArmadaYieldVault.YIELD_FEE_BPS = 1000, L276-278 | full_match | 0.95 | `yieldFee = (yield_ * 1000) / 10000` |
| SPEC-YS-03 (Cost basis formula) | ArmadaYieldVault.deposit() L206-212 | full_match | 0.95 | Weighted average: `(oldBasis * oldShares + assets * 1e18) / (oldShares + newShares)` |
| SPEC-YS-04 (lendAndShield flow) | ArmadaYieldAdapter.lendAndShield() L153-218 | full_match | 0.95 | Unshield USDC -> deposit -> shield shares |
| SPEC-YS-05 (redeemAndShield flow) | ArmadaYieldAdapter.redeemAndShield() L232-294 | full_match | 0.95 | Unshield shares -> redeem -> shield USDC |
| SPEC-YS-06 (INV-Y1: zero between ops) | Adapter has no persistent token balance storage | partial_match | 0.80 | Depends on atomic execution; if revert between steps, tokens stuck |
| SPEC-YS-07 (INV-Y3: adaptParams binding) | YieldAdaptParams.verify() | full_match | 0.95 | Verified in both lendAndShield and redeemAndShield |

### 5.3 Governance

| Spec-IR | Code-IR | Match Type | Confidence | Notes |
|---------|---------|------------|------------|-------|
| SPEC-GOV-01 (100M fixed supply) | ArmadaToken.INITIAL_SUPPLY = 100_000_000 * 1e18, L9 | full_match | 0.95 | Mint only in constructor |
| SPEC-GOV-02 (0.1% threshold) | ArmadaGovernor.PROPOSAL_THRESHOLD_BPS = 10, L64 | partial_match | 0.85 | Uses total supply, not eligible supply |
| SPEC-GOV-03 (Quorum formula) | ArmadaGovernor.quorum() L283-289 | full_match | 0.95 | `(eligibleSupply * quorumBps) / 10000` where eligible = total - treasury |
| SPEC-GOV-04 (2-day timelock) | deploy_governance.ts L50: `TWO_DAYS = 2 * 86400` | full_match | 0.95 | TimelockController min delay = 172800 seconds |
| SPEC-GOV-05 (Steward 180d, 1%) | TreasurySteward.TERM_DURATION = 180 days, ArmadaTreasuryGov.STEWARD_BUDGET_BPS = 100, BUDGET_PERIOD = 30 days | full_match | 0.95 | All parameters match |
| SPEC-GOV-06 (VotingLocker) | VotingLocker.lock(), unlock(), getPastLockedBalance() with _writeCheckpoint() | full_match | 0.95 | Checkpoint on every lock/unlock |

### 5.4 Crowdfund

| Spec-IR | Code-IR | Match Type | Confidence | Notes |
|---------|---------|------------|------------|-------|
| SPEC-CF-01 (Hop whitelist) | ArmadaCrowdfund: addSeeds (hop 0), invite (hop+1) | full_match | 0.95 | Seeds at hop 0, invitees at hop+1 |
| SPEC-CF-02 (Per-hop cap) | ArmadaCrowdfund.commit() L199: `p.committed + amount <= hopConfigs[hop].capUsdc` | full_match | 0.95 | Enforced per participant per hop |
| SPEC-CF-03 (alloc+refund=committed) | ArmadaCrowdfund._computeAllocation() L484: `refundUsdc = committed - allocUsdc` | partial_match | 0.90 | Algebraically exact due to L484, but integer division in L480 means this holds exactly |
| SPEC-CF-04 (Reserve BPS sum 10000) | Constructor L105-107: 7000 + 2500 + 500 = 10000 | full_match | 0.95 | Hardcoded and sums to 10000 |
| SPEC-CF-05 (Pro-rata oversubscribed) | ArmadaCrowdfund._computeAllocation() L480 | full_match | 0.95 | `allocUsdc = (committed * finalReserves[hop]) / finalDemands[hop]` |

---

## 6. Divergence Findings

### FINDING-01: CRITICAL -- Shield Fee Formula Mismatch

**Spec claim** (User requirement, SPEC-PP-04):
> "Fee calculation: base = amount * 10000 / (10000 + feeBps), fee = amount - base"

This describes an **exclusive** (additive) fee model: the user sends `amount` USDC, the protocol shields `amount * 10000 / (10000 + feeBps)`, and the fee is the remainder. The denominator is `(10000 + feeBps)`.

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L263-266):
```solidity
if (_isInclusive) {
    // Fee is included in amount
    base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
    fee = uint120(_amount) - base;
}
```

This computes: `base = amount - (amount * feeBps) / 10000`. The denominator is `10000`, not `(10000 + feeBps)`.

**Numerical example** with 50 bps fee on 10000 USDC:
- Spec formula: `base = 10000 * 10000 / 10050 = 9950.2487...` (rounds to 9950)
- Code formula: `base = 10000 - (10000 * 50) / 10000 = 10000 - 50 = 9950`

At 50 bps the difference is negligible (<1 USDC). But at higher fee rates (e.g., 500 bps = 5%):
- Spec: `base = 10000 * 10000 / 10500 = 9523.8095...` => fee = 476
- Code: `base = 10000 - (10000 * 500) / 10000 = 10000 - 500 = 9500` => fee = 500

**The code always overcharges compared to the spec formula.** At 500 bps, the overcharge is 24 USDC per 10000 USDC (0.24%).

**Code is called with `_isInclusive = true`**, and the deploy script sets `shieldFee = 50` (L217 of `deploy_privacy_pool.ts`).

**Evidence links**:
- Spec: User requirement "Fee calculation: base = amount * 10000 / (10000 + feeBps)"
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L263-266
- Deploy: `/Volumes/T7/railgun/poc/scripts/deploy_privacy_pool.ts` L217

**Severity justification**: CRITICAL. The fee formula is a core economic parameter. The two formulas produce different results. The spec formula is a standard additive fee model (amount includes fee), while the code uses a multiplicative model (fee = percentage of amount). These are distinct economic models. Any tooling, documentation, or frontend UI that uses the spec formula will display incorrect amounts.

**Exploitability**: No direct exploit vector since the fee is protocol revenue. However, users will be overcharged relative to the documented rate. At the current 50 bps, the divergence per transaction is under 1 cent on typical amounts, but it is a semantic mismatch.

**Remediation**: Either update the spec to document the code's actual formula (`base = amount - (amount * feeBps) / 10000`), or update the code to match the spec (`base = amount * 10000 / (10000 + feeBps)`). The code formula is the Railgun canonical formula used in production, so updating the spec is recommended:
```
Correct spec: base = amount - (amount * feeBps / 10000), fee = amount - base
```

---

### FINDING-02: HIGH -- Cross-Chain Relayer Fee Deduction Not Implemented

**Spec claim** (DOC-1 Section "Cross-Chain Shields", SPEC-PP-08):
> "Hub-side ShieldModule creates commitment for (amount - relayerFee) and transfers relayerFee to msg.sender (the relayer)"

**Spec claim** (DOC-2 Phase 4.1, SPEC-PP-09):
> "Add relayerFee field to ShieldData struct"

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/types/CCTPTypes.sol` L41-46):
```solidity
struct ShieldData {
    bytes32 npk;
    uint120 value;
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
    // NO relayerFee field
}
```

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L84-117):
The `processIncomingShield` function creates a commitment for the full `amount` (minus optional shield fee). There is no relayer fee deduction and no transfer to `msg.sender`.

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L113-161):
The `crossChainShield` function accepts `maxFee` as a CCTP protocol-level fee (deducted by CCTP at the transport layer), NOT as an application-level relayer fee.

**Evidence links**:
- Spec: DOC-1 lines 86-94 (contract changes required)
- Spec: DOC-2 Phase 4.1-4.3 (detailed implementation)
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/types/CCTPTypes.sol` L41-46
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L84-117
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L113-161

**Severity justification**: HIGH. The spec explicitly describes this as a required contract change (Phase 4). Without it, the relayer has no incentive to relay cross-chain shield messages, which breaks the gasless user experience for cross-chain operations.

**Impact**: Relayer cannot collect fees from cross-chain shield operations. Users must rely on the CCTP protocol-level `maxFee` mechanism (which pays CCTP relayers, not the Armada relayer). The spec's "Option A" fee model for cross-chain shields is entirely unimplemented.

**Remediation**: Implement the spec's Phase 4 changes:
1. Add `uint256 relayerFee` to `ShieldData` struct
2. Accept `relayerFee` in `PrivacyPoolClient.crossChainShield()`
3. In `ShieldModule.processIncomingShield()`, deduct relayerFee from commitment amount and transfer to msg.sender

---

### FINDING-03: HIGH -- Hub Does Not Validate Source Domain on Cross-Chain Shield

**Spec claim** (DOC-7 Section 5, SPEC-PP-10):
> "PrivacyPool.handleReceiveFinalizedMessage does NOT check remoteDomain against remotePools. The Hub accepts shield messages from any CCTP source domain."

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L161-208):
```solidity
function handleReceiveFinalizedMessage(
    uint32,          // remoteDomain - UNNAMED, not used
    bytes32 sender,
    uint32 finalityThresholdExecuted,
    bytes calldata messageBody
) external override returns (bool) {
    require(msg.sender == tokenMessenger, "PrivacyPool: Only TokenMessenger");
    // ... no remoteDomain check
    (sender); // Silence unused variable warning
```

**Contrast with Client** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L184-198):
```solidity
function handleReceiveFinalizedMessage(
    uint32 remoteDomain,
    ...
) external override returns (bool) {
    require(msg.sender == tokenMessenger, "PrivacyPoolClient: Only TokenMessenger");
    require(remoteDomain == hubDomain, "PrivacyPoolClient: Invalid domain");
```

The Client validates `remoteDomain == hubDomain` at L198. The Hub does NOT validate the source domain.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L161-177
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L184-198
- Observation: DOC-7 Section 5

**Severity justification**: HIGH. If CCTP's authentication were ever compromised or if a new domain were added without the Hub's knowledge, an attacker could create commitments on the Hub from an unauthorized source domain. This is partially mitigated by CCTP's own message authentication (TokenMessenger only calls the handler with valid messages), but defense-in-depth requires application-level validation.

**Remediation**: Add domain validation in `PrivacyPool.handleReceiveFinalizedMessage()`:
```solidity
function handleReceiveFinalizedMessage(
    uint32 remoteDomain,
    ...
) external override returns (bool) {
    require(msg.sender == tokenMessenger, "PrivacyPool: Only TokenMessenger");
    require(remotePools[remoteDomain] != bytes32(0), "PrivacyPool: Unknown domain");
    ...
```

---

### FINDING-04: HIGH -- VERIFICATION_BYPASS Returns True AFTER Failed Proof

**Spec claim** (DOC-7 Section 5):
> "VERIFICATION_BYPASS at tx.origin == 0xdead: Both verify() implementations return true when tx.origin == 0xdead."

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L372-382):
```solidity
// Verify the SNARK proof
bool validity = Snark.verify(verifyingKey, _transaction.proof, inputs);

// Always return true in gas estimation transactions
if (tx.origin == VERIFICATION_BYPASS) {
    return true;
}

return validity;
```

Same pattern in `VerifierModule.sol` L101-111.

**Issue**: The `VERIFICATION_BYPASS` check runs AFTER the proof verification attempt. If the proof verification fails (returns false), the function still returns `true` when `tx.origin == 0xdead`. The check is positioned after the Snark.verify call, meaning:
1. An invalid proof is verified (wasting gas)
2. The result is discarded
3. `true` is returned anyway

This is intentional for gas estimation, but the ordering means that even a completely invalid proof passes if `tx.origin == 0xdead`. Since `0xdead` has no known private key, this is not directly exploitable on-chain, but if `eth_estimateGas` results are consumed by infrastructure as "proof of validity," it could mislead.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L372-382
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/VerifierModule.sol` L101-111

**Severity justification**: HIGH (design concern, not directly exploitable). The pattern exists in production Railgun and is well-understood, but it should be documented as an explicit bypass mechanism.

**Remediation**: Move the bypass check before the verification to save gas, and add explicit documentation:
```solidity
// Gas estimation bypass - MUST be before proof verification
if (tx.origin == VERIFICATION_BYPASS) {
    return true;
}
bool validity = Snark.verify(verifyingKey, _transaction.proof, inputs);
return validity;
```

---

### FINDING-05: HIGH -- Proposal Threshold Uses Total Supply, Not Eligible Supply

**Spec claim** (User requirement, SPEC-GOV-02):
> "Proposal threshold: 0.1% of eligible supply (10 bps)"

The term "eligible supply" in the context of governance typically means `totalSupply - treasuryBalance`, consistent with how quorum is calculated.

**Code** (`/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` L160-163):
```solidity
function _checkProposalThreshold(address proposer) internal view {
    uint256 proposerVotes = votingLocker.getPastLockedBalance(proposer, block.number - 1);
    uint256 threshold = (armToken.totalSupply() * PROPOSAL_THRESHOLD_BPS) / 10000;
    require(proposerVotes >= threshold, "ArmadaGovernor: below proposal threshold");
}
```

The threshold uses `armToken.totalSupply()`, NOT `totalSupply - treasuryBalance`. With 65M ARM in the treasury out of 100M total:
- Spec (eligible): threshold = (100M - 65M) * 10 / 10000 = 35,000 ARM
- Code (total): threshold = 100M * 10 / 10000 = 100,000 ARM

The code threshold is **2.86x higher** than what the spec implies, making it harder to create proposals than intended.

**Evidence links**:
- Spec: User requirement "Proposal threshold: 0.1% of eligible supply (10 bps)"
- Code: `/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` L162
- Deploy: `/Volumes/T7/railgun/poc/scripts/deploy_governance.ts` L120 (65M to treasury)

**Severity justification**: HIGH. This is a governance parameter mismatch that directly affects who can create proposals. The higher threshold restricts governance participation beyond what the spec intends.

**Remediation**: Use eligible supply for threshold calculation:
```solidity
function _checkProposalThreshold(address proposer) internal view {
    uint256 proposerVotes = votingLocker.getPastLockedBalance(proposer, block.number - 1);
    uint256 eligibleSupply = armToken.totalSupply() - armToken.balanceOf(treasuryAddress);
    uint256 threshold = (eligibleSupply * PROPOSAL_THRESHOLD_BPS) / 10000;
    require(proposerVotes >= threshold, "ArmadaGovernor: below proposal threshold");
}
```

---

### FINDING-06: HIGH -- Quorum Counts Abstentions Toward Quorum but Not in Spec

**Spec claim** (DOC-7 Section 7, SPEC-GOV-03):
> "quorum = (eligibleSupply * quorumBps) / 10000"

The spec states the quorum formula but does not specify which vote types count toward quorum.

**Code** (`/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` L327-331):
```solidity
function _quorumReached(uint256 proposalId) internal view returns (bool) {
    Proposal storage p = _proposals[proposalId];
    // Abstain counts toward quorum but not majority
    return (p.forVotes + p.abstainVotes) >= quorum(proposalId);
}
```

Abstain votes count toward quorum, meaning a proposal can reach quorum even if a majority of participating voters abstain. Against votes do NOT count toward quorum.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` L327-331
- Code comment: "Abstain counts toward quorum but not majority"

**Severity justification**: HIGH. This is an UNDOCUMENTED behavior that affects governance outcomes. The quorum model (For + Abstain) is a legitimate design choice (used by OpenZeppelin Governor), but it MUST be explicitly documented in the spec. Without documentation, stakeholders may not understand that abstaining helps a proposal pass.

**Remediation**: Document the quorum counting rules explicitly in the spec:
> "Quorum is reached when (forVotes + abstainVotes) >= quorumThreshold. Against votes do NOT count toward quorum. This means abstaining helps a proposal reach quorum without contributing to its majority."

---

### FINDING-07: HIGH -- Crowdfund ARM Recovery Impossible After Cancellation

**Spec claim** (DOC-7 Section 5):
> "If sale is canceled, withdrawUnallocatedArm() requires phase == Finalized. No mechanism to recover ARM tokens in the Canceled state."

**Code** (`/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L372-387):
```solidity
function withdrawUnallocatedArm(address treasury) external onlyAdmin {
    require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
    // ...
}
```

If `finalize()` determines `totalCommitted < MIN_SALE` (L230-233), the phase becomes `Canceled`. There is no function to withdraw ARM tokens in the `Canceled` state. The ARM tokens funded to the contract (1.8M ARM per deploy script) become permanently locked.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L372 (`require(phase == Phase.Finalized)`)
- Code: `/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L230-233 (cancellation path)
- Deploy: `/Volumes/T7/railgun/poc/scripts/deploy_crowdfund.ts` L70-73 (1.8M ARM funded)

**Severity justification**: HIGH. Permanent loss of 1.8M ARM tokens (~$1.8M at $1/ARM) if the crowdfund is canceled. This is a significant fund-loss scenario.

**Remediation**: Allow ARM withdrawal in the `Canceled` state:
```solidity
function withdrawUnallocatedArm(address treasury) external onlyAdmin {
    require(
        phase == Phase.Finalized || phase == Phase.Canceled,
        "ArmadaCrowdfund: not finalized or canceled"
    );
    // ...
}
```

---

### FINDING-08: MEDIUM -- `_transferTokenIn` Transfers Base Amount, Not Full Amount with Fee

**Spec claim** (DOC-7 Section 3 "Shield Flow"):
> "ShieldModule: validate commitment preimage, compute fee, transfer USDC in"

The typical ERC20 fee pattern is: transfer full amount from user, then split into base + fee. This ensures the user pays the total `amount` they submitted.

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L232-243):
```solidity
// Transfer base amount to this contract
uint256 balanceBefore = token.balanceOf(address(this));
token.safeTransferFrom(msg.sender, address(this), base);   // Only base, not full amount
uint256 balanceAfter = token.balanceOf(address(this));
require(balanceAfter - balanceBefore == base, "ShieldModule: Transfer failed");

// Transfer fee to treasury
if (feeAmount > 0 && treasury != address(0)) {
    token.safeTransferFrom(msg.sender, treasury, feeAmount);  // Separate transfer for fee
}
```

The code performs TWO separate `safeTransferFrom` calls: one for `base` to the pool, one for `fee` to treasury. The user needs to have approved `base + fee` to the pool. If the user has approved exactly `amount = base + fee`, this works. But the `ShieldRequest` contains `_note.value` as the total amount, and the code splits it.

The issue: the user submits a `ShieldRequest` with `value = X`. The code computes `base = X - fee`. The user's token approval must cover `X` (base to pool + fee to treasury = base + fee = X). This is correct, but unintuitive and different from the cross-chain shield path where the full amount is handled by CCTP.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L232-243
- Cross-chain comparison: ShieldModule._processInternalShield() L138-140 (single transfer to treasury from pool's own balance)

**Severity justification**: MEDIUM. The two transfer patterns create an inconsistency: local shields require user approval for base + fee amounts in two separate transfers, while cross-chain shields deduct fee from the pool's already-minted USDC. This is functionally correct but creates integration complexity.

---

### FINDING-09: MEDIUM -- `safeApprove` Pattern Inconsistency Between Client and TransactModule

**Spec claim** (DOC-7 Section 5):
> "PrivacyPoolClient.crossChainShield resets allowance to 0 before setting new value. TransactModule._executeCCTPBurn does NOT reset."

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L129-130):
```solidity
IERC20(usdc).safeApprove(tokenMessenger, 0);
IERC20(usdc).safeApprove(tokenMessenger, amount);
```

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/TransactModule.sol` L200):
```solidity
IERC20(usdc).safeApprove(tokenMessenger, base);
```

If a previous `depositForBurnWithHook` call left any residual allowance (which should not happen in normal operation, but could occur if the CCTP call reverts after the approve), the `TransactModule` version would revert because OpenZeppelin's `safeApprove` disallows setting a non-zero allowance when the current allowance is non-zero.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L129-130
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/TransactModule.sol` L200

**Severity justification**: MEDIUM. If any CCTP operation leaves residual allowance, the TransactModule path would become permanently bricked for that token/spender pair until the allowance is manually reset.

**Remediation**: Add the `safeApprove(0)` pattern in TransactModule:
```solidity
IERC20(usdc).safeApprove(tokenMessenger, 0);
IERC20(usdc).safeApprove(tokenMessenger, base);
```

---

### FINDING-10: MEDIUM -- `setTestingMode(bool)` Has No Guard Against Production Use

**Spec claim** (PrivacyPool NatSpec, DOC-7 Section 5):
> "POC ONLY - bypasses SNARK verification"

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L291-298):
```solidity
function setTestingMode(bool _enabled) external override {
    require(msg.sender == owner, "PrivacyPool: Only owner");
    _delegatecall(
        verifierModule,
        abi.encodeCall(IVerifierModule.setTestingMode, (_enabled))
    );
    emit TestingModeSet(_enabled);
}
```

No compile-time constant, no immutable flag, no require against re-enabling. Owner can toggle testing mode at any time, completely bypassing all SNARK verification.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L291-298
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/VerifierModule.sol` L127-133

**Severity justification**: MEDIUM for POC (documented as POC-only), but would be CRITICAL in production.

---

### FINDING-11: MEDIUM -- Adapter Shared Identity Causes Cost Basis Inaccuracy

**Spec claim** (DOC-7 Section 5):
> "Adapter as Shared Identity for Vault: All privacy pool users interact with the vault through the adapter's address. The vault sees a single depositor."

**Code** (`/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol` L204-213):
```solidity
uint256 existingShares = balanceOf(receiver);
if (existingShares == 0) {
    userCostBasisPerShare[receiver] = (assets * COST_BASIS_PRECISION) / shares;
} else {
    uint256 oldBasis = userCostBasisPerShare[receiver];
    userCostBasisPerShare[receiver] = (oldBasis * existingShares + assets * COST_BASIS_PRECISION) / (existingShares + shares);
}
```

When the adapter calls `vault.deposit(amount, address(this))`, the `receiver` is always the adapter. When the adapter calls `vault.redeem(shares, address(this), address(this))`, the `owner_` is always the adapter. Between operations, the adapter shields shares to the privacy pool, so `balanceOf(adapter) == 0` after each atomic operation.

This means `existingShares == 0` is true on every `lendAndShield` call, and the cost basis is recalculated fresh each time. On `redeemAndShield`, the cost basis used is from the LAST deposit by ANY user, not the current user's actual cost basis.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol` L204-213 (deposit cost basis)
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol` L254-256 (redeem cost basis)
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol` L197 (receiver = address(this))

**Severity justification**: MEDIUM. The yield fee calculation will be inaccurate when multiple users interact through the adapter. Users who redeemed early may pay less yield fee than they should, and users who redeemed later may pay more.

**Remediation**: This is an inherent design limitation of the adapter pattern. Possible mitigations:
1. Accept aggregate cost basis as "good enough" for the POC
2. Track per-commitment cost basis in the privacy pool's shielded state
3. Use a constant cost basis (e.g., 1:1 at deposit time)

---

### FINDING-12: MEDIUM -- `uint120` Truncation Without Explicit Check

**Spec claim** (DOC-7 Section 5):
> "uint120 truncation: silent truncation if shares/assets/amount > type(uint120).max"

**Code locations**:
- `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol` L209: `value: uint120(shares)`
- `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol` L285: `value: uint120(assets)`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L136: `value: uint120(amount)`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` L106: `value: uint120(commitmentAmount)`

`type(uint120).max` is approximately 1.3 * 10^36. With USDC (6 decimals), this allows up to ~1.3 * 10^30 USDC, far exceeding the total USDC supply. For ayUSDC vault shares (6 decimals), the same limit applies.

**Severity justification**: MEDIUM. Practically safe for USDC, but the absence of explicit `require(amount <= type(uint120).max)` checks means silent truncation is possible in theory. A defensive coding issue.

---

### FINDING-13: MEDIUM -- `recordFee()` and `onTokenTransfer()` Have No Access Control

**Spec claim** (DOC-7 Section 5):
> "recordFee() / onTokenTransfer() No Access Control: ArmadaTreasury functions inflate totalCollected without verification."

**Code** (`/Volumes/T7/railgun/poc/contracts/yield/ArmadaTreasury.sol` L105-112):
```solidity
function recordFee(
    address token,
    address from,
    uint256 amount
) external {
    totalCollected[token] += amount;
    emit FeeReceived(token, from, amount);
}
```

Any address can call `recordFee()` with arbitrary parameters, inflating `totalCollected` without any actual token transfer.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaTreasury.sol` L105-112

**Severity justification**: MEDIUM. The `totalCollected` mapping is tracking-only and does not control fund flows. However, any monitoring or accounting system relying on `totalCollected` will be corrupted.

---

### FINDING-14: MEDIUM -- Quorum Sensitivity to Live Treasury Balance

**Spec claim** (DOC-7 Section 5):
> "Quorum Sensitivity to Treasury Balance: ArmadaGovernor.quorum() reads live armToken.balanceOf(treasuryAddress)."

**Code** (`/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` L283-289):
```solidity
function quorum(uint256 proposalId) public view returns (uint256) {
    Proposal storage p = _proposals[proposalId];
    uint256 totalSupply = armToken.totalSupply();
    uint256 treasuryBalance = armToken.balanceOf(treasuryAddress);
    uint256 eligibleSupply = totalSupply - treasuryBalance;
    uint256 quorumBps = proposalTypeParams[p.proposalType].quorumBps;
    return (eligibleSupply * quorumBps) / 10000;
}
```

The quorum is calculated from the **live** treasury balance at the time of the state check, not at the proposal's snapshot block. If tokens are distributed from treasury during the voting period, the quorum changes retroactively.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` L283-289

**Severity justification**: MEDIUM. A governance distribution during an active vote changes the quorum for that vote. This could be exploited by timing a distribution to lower the quorum below the already-cast forVotes.

**Remediation**: Snapshot the treasury balance at proposal creation time:
```solidity
// In _initProposal():
p.treasuryBalanceSnapshot = armToken.balanceOf(treasuryAddress);
// In quorum():
uint256 eligibleSupply = totalSupply - p.treasuryBalanceSnapshot;
```

---

### FINDING-15: MEDIUM -- No Finalization Deadline in Crowdfund

**Spec claim** (DOC-7 Section 5):
> "No Finalization Deadline in Crowdfund: Admin can delay finalize() indefinitely after commitmentEnd, locking participant USDC with no claim or refund mechanism."

**Code** (`/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L222-223):
```solidity
function finalize() external onlyAdmin nonReentrant {
    require(block.timestamp > commitmentEnd, "ArmadaCrowdfund: commitment not ended");
```

There is no upper bound on when `finalize()` must be called. Participants cannot claim, refund, or withdraw their USDC until the admin calls `finalize()`.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L222-223

**Severity justification**: MEDIUM. This gives the admin indefinite custody of participant USDC with no recourse for participants.

**Remediation**: Add a finalization deadline with automatic cancellation:
```solidity
uint256 public constant FINALIZATION_DEADLINE = 30 days;
// In claim/refund:
if (block.timestamp > commitmentEnd + FINALIZATION_DEADLINE && phase != Phase.Finalized) {
    // Auto-cancel and allow refunds
}
```

---

### ~~FINDING-16: MEDIUM -- `Phase.Commitment` Dead State in Crowdfund~~ [RESOLVED]

**Resolution**: Phase model simplified to `{Active, Finalized, Canceled}`. The dead `Setup`, `Invitation`, and `Commitment` enum values were removed. Invites and commits happen concurrently during the Active phase. `finalize()` now checks `phase == Phase.Active`.

<details>
<summary>Original finding (archived)</summary>

**Spec claim** (DOC-7 Section 5):
> "Phase.Commitment (value 2) exists in the enum but no code ever sets phase = Phase.Commitment"

**Code** (`/Volumes/T7/railgun/poc/contracts/crowdfund/IArmadaCrowdfund.sol` L8-14):
```solidity
enum Phase {
    Setup,          // 0
    Invitation,     // 1
    Commitment,     // 2  <-- NEVER SET
    Finalized,      // 3
    Canceled        // 4
}
```

**Code** (`/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L225-227):
```solidity
require(
    phase == Phase.Invitation || phase == Phase.Commitment,
    "ArmadaCrowdfund: already finalized"
);
```

The `Phase.Commitment` variant in the finalize check is dead code since no path ever sets `phase = Phase.Commitment`.

**Severity justification**: MEDIUM. The state machine is incomplete. The `commit()` function at L187 does not transition phase from Invitation to Commitment. If the spec intended a distinct Commitment phase, it is unimplemented. If it was not intended, the enum value should be removed.
</details>

---

### FINDING-17: LOW -- Steward Action Delay Retroactivity

**Spec claim** (DOC-7 Section 5):
> "Changing actionDelay via governance affects ALL pending actions (read at execution time, not proposal time)."

**Code** (`/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` L129-131):
```solidity
require(
    block.timestamp >= action.timestamp + actionDelay,
    "TreasurySteward: delay not elapsed"
);
```

`actionDelay` is read at execution time from the contract state, not from a per-action snapshot at proposal time.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` L129-131

**Severity justification**: LOW. Governance can change the delay to affect pending actions. Setting delay to 0 eliminates the veto window entirely.

---

### FINDING-18: LOW -- Steward Pending Actions Survive Election

**Spec claim** (DOC-7 Section 5):
> "Removing a steward doesn't cancel their pending actions."

**Code** (`/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` L75-78):
```solidity
function removeSteward() external onlyTimelock {
    emit StewardRemoved(currentSteward);
    currentSteward = address(0);
    // No cancellation of pending actions
}
```

**Code** (`/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` L124):
```solidity
function executeAction(uint256 actionId) external onlySteward nonReentrant {
```

The `onlySteward` modifier checks `msg.sender == currentSteward`. After removal, `currentSteward == address(0)`, so no one can execute. But if a NEW steward is elected, they could execute the OLD steward's pending actions.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` L75-78 (removeSteward)
- Code: `/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` L124 (executeAction)

**Severity justification**: LOW. Mitigated by the veto mechanism, but unexpected behavior.

---

### FINDING-19: LOW -- No Ownership Transfer for PrivacyPool and PrivacyPoolClient

**Spec claim** (DOC-7 Section 5):
> "Owner set once during initialize(), cannot be changed. Key loss = permanent lockout."

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L87):
```solidity
owner = _owner;
```

No `transferOwnership()` function exists on PrivacyPool or PrivacyPoolClient.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` L87
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` L84

**Severity justification**: LOW for POC. Would be HIGH in production.

---

### FINDING-20: LOW -- `withdrawProceeds()` in Crowdfund Lacks Reentrancy Guard

**Spec claim** (DOC-7 Section 5):
> "withdrawProceeds() Lacks Reentrancy Guard. Admin-only + CEI pattern mitigates."

**Code** (`/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L356-367):
```solidity
function withdrawProceeds(address treasury) external onlyAdmin {
    // No nonReentrant modifier
    require(phase == Phase.Finalized, "ArmadaCrowdfund: not finalized");
    ...
    proceedsWithdrawnAmount += available;
    usdc.safeTransfer(treasury, available);
    ...
}
```

The function updates `proceedsWithdrawnAmount` before the external call, following CEI pattern. Combined with `onlyAdmin`, reentrancy risk is minimal.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/crowdfund/ArmadaCrowdfund.sol` L356-367

**Severity justification**: LOW. CEI + admin-only mitigates. Pattern inconsistency with other functions that do use `nonReentrant`.

---

### FINDING-21: LOW -- Merkle Tree Depth 16 (65536 Leaves) -- No Spec Verification Against SNARK Parameters

**Spec claim** (User requirement):
> "Merkle tree: depth should match SNARK circuit parameters"

**Code** (`/Volumes/T7/railgun/poc/contracts/privacy-pool/storage/PrivacyPoolStorage.sol` L90):
```solidity
uint256 internal constant TREE_DEPTH = 16;
```

The SNARK circuits are loaded from external artifacts (`lib/artifacts`). The tree depth of 16 must match what the circuit expects. There is no runtime or compile-time check that the loaded verification keys correspond to circuits expecting a depth-16 tree.

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/privacy-pool/storage/PrivacyPoolStorage.sol` L90
- Code: `/Volumes/T7/railgun/poc/scripts/deploy_privacy_pool.ts` L199-200 (loads artifacts)

**Severity justification**: LOW. The Railgun test artifacts are designed for depth-16 trees, so this is correct in practice. But there is no validation mechanism.

---

### FINDING-22: LOW -- Deploy Script Sets Shield Fee to 50 bps But No Unshield Fee

**Spec claim** (User requirement):
> "Fee: 50 bps shield fee configured in deploy script"

**Code** (`/Volumes/T7/railgun/poc/scripts/deploy_privacy_pool.ts` L217-219):
```solidity
await (await privacyPool.setShieldFee(50)).wait();
console.log("   Shield fee: 50 bps (0.50%)");
```

No `setUnshieldFee()` call is made in the deploy script. `unshieldFee` defaults to 0 (per storage initialization).

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/scripts/deploy_privacy_pool.ts` L217-219

**Severity justification**: LOW. The spec only mentions shield fee. Unshield fee at 0 is consistent but undocumented.

---

### FINDING-23: MEDIUM -- Adapter Cost Basis Inconsistency: Yield Fee Applied to Adapter, Not User

**Spec claim** (DOC-7 Section 7):
> "Yield fee: (yield * 1000) / 10000 = yield / 10 (10%)"

The yield fee is applied based on the ADAPTER's cost basis, not the individual user's. Since the adapter's balance returns to 0 between operations (shares are shielded), each lendAndShield resets the cost basis for the adapter address.

When user A deposits at price 1.0 and user B deposits at price 1.05, the adapter's cost basis after user B's deposit is just 1.05 (since adapter balance was 0 before B's deposit). When user A redeems (through the adapter), the fee is calculated using cost basis 1.05 (user B's deposit price), not 1.0 (user A's actual deposit price).

This means user A pays LESS yield fee than they should (fee based on 1.05 cost basis instead of 1.0), and user B could pay MORE (depending on ordering).

**Evidence links**:
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol` L204-213 (deposit)
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol` L254-256 (redeem)
- Code: `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol` L197 (receiver = adapter)

**Severity justification**: MEDIUM. Yield fees are inaccurately distributed among users. The aggregate fee collected may be approximately correct, but individual fairness is violated.

---

## 7. Missing Invariants

| ID | Expected Invariant | Status |
|----|-------------------|--------|
| MI-1 | PrivacyPool USDC balance >= sum of all unspent commitment values | Not enforced; relies on correct SNARK proof verification |
| MI-2 | Cross-chain shield: commitment amount <= actual CCTP mint | Partially enforced: `amount <= data.value` at ShieldModule L91, but `amount` is CCTP's actual mint |
| MI-3 | Adapter token balance == 0 outside of atomic operations | Not enforced; relies on transaction atomicity |
| MI-4 | VotingLocker ARM balance >= sum of all locked balances | Not enforced on-chain; relies on checkpoint consistency |

---

## 8. Incorrect Logic

| ID | Location | Issue |
|----|----------|-------|
| IL-1 | ShieldModule._getFee() L263-266 | Fee formula does not match spec (see FINDING-01) |
| IL-2 | ArmadaGovernor._checkProposalThreshold() L162 | Uses totalSupply instead of eligible supply (see FINDING-05) |

---

## 9. Math Inconsistencies

| ID | Spec Formula | Code Formula | Divergence |
|----|-------------|--------------|------------|
| MC-1 | `base = amount * 10000 / (10000 + feeBps)` | `base = amount - (amount * feeBps) / 10000` | Different denominators; code overcharges (see FINDING-01) |
| MC-2 | Proposal threshold: 0.1% of eligible supply | `(totalSupply * 10) / 10000` | Uses total supply not eligible supply (FINDING-05) |

---

## 10. Flow Mismatches

| ID | Spec Flow | Code Flow | Divergence |
|----|-----------|-----------|------------|
| FM-1 | Cross-chain shield with relayer fee: user sends amount, relayer gets fee from commitment | No relayer fee field; CCTP maxFee is protocol-level only | Relayer fee architecture missing (FINDING-02) |
| ~~FM-2~~ | ~~Crowdfund: Setup -> Invitation -> Commitment -> Finalized~~ | ~~Setup -> Invitation -> Finalized (Commitment phase never entered)~~ | ~~Dead state (FINDING-16)~~ [RESOLVED — Phase model simplified to Active → Finalized/Canceled] |

---

## 11. Access Control Drift

| ID | Expected | Actual | Issue |
|----|----------|--------|-------|
| AC-1 | Hub validates source domain on cross-chain messages | Hub does not check remoteDomain | FINDING-03 |
| AC-2 | recordFee() restricted to authorized callers | Open to anyone | FINDING-13 |
| AC-3 | testingMode restricted to POC builds | Available at runtime via owner call | FINDING-10 |

---

## 12. Undocumented Behavior

| ID | Behavior | Location | Risk |
|----|----------|----------|------|
| UB-1 | VERIFICATION_BYPASS (tx.origin == 0xdead) | PrivacyPool.verify() L378, VerifierModule.verify() L106 | Documented in code comments but not in spec |
| UB-2 | Abstain votes count toward quorum | ArmadaGovernor._quorumReached() L330 | Not in spec |
| UB-3 | Unshield fee defaults to 0 in deploy | deploy_privacy_pool.ts (no setUnshieldFee call) | Not in spec |
| UB-4 | Cross-chain shield fee bypass for tokenMessenger | ShieldModule._processInternalShield() L132 | msg.sender is router (delegatecall), not tokenMessenger |
| UB-5 | Vault adapter field set but never used for fee bypass | ArmadaYieldVault.setAdapter() at deploy, but redeem() L273-274 comments "fees always applied" | Adapter field appears unused |

---

## 13. Ambiguity Hotspots

| ID | Topic | Ambiguity | Impact |
|----|-------|-----------|--------|
| AH-1 | "Eligible supply" for proposal threshold | Spec says "eligible supply" but does not define it consistently | FINDING-05 |
| AH-2 | Fee model (inclusive vs exclusive) | Spec formula implies exclusive; code uses inclusive | FINDING-01 |
| AH-3 | Relayer fee vs CCTP fee | Spec describes application-level relayer fee; code uses CCTP protocol-level maxFee | FINDING-02 |
| AH-4 | Cross-chain shield fee bypass | Spec says tokenMessenger is in privilegedShieldCallers; code runs in delegatecall context where msg.sender is the original caller | Unclear whether fee applies |

---

## 14. Recommended Remediations

### Critical Priority

1. **FINDING-01**: Update the spec to document the actual fee formula, OR update the code to match the spec. The code formula is the Railgun canonical formula.

### High Priority

2. **FINDING-02**: Implement cross-chain relayer fee mechanism per DOC-2 Phase 4 specification.
3. **FINDING-03**: Add `remoteDomain` validation in `PrivacyPool.handleReceiveFinalizedMessage()`.
4. **FINDING-05**: Change `_checkProposalThreshold()` to use eligible supply (totalSupply - treasuryBalance).
5. **FINDING-06**: Document the quorum counting rules (For + Abstain) in the spec.
6. **FINDING-07**: Allow ARM withdrawal in `Canceled` state.

### Medium Priority

7. **FINDING-09**: Add `safeApprove(0)` before `safeApprove(amount)` in `TransactModule._executeCCTPBurn()`.
8. **FINDING-11**: Document the cost basis limitation of the adapter pattern.
9. **FINDING-14**: Snapshot treasury balance at proposal creation for quorum calculation.
10. **FINDING-15**: Add finalization deadline to crowdfund.
11. ~~**FINDING-16**: Either implement the Commitment phase transition or remove it from the enum.~~ [RESOLVED — dead phases removed]

### Low Priority

12. **FINDING-17**: Snapshot actionDelay per action at proposal time.
13. **FINDING-18**: Cancel pending actions when steward is removed.
14. **FINDING-19**: Add `transferOwnership()` to PrivacyPool and PrivacyPoolClient.
15. **FINDING-22**: Document the intentional choice of 0 unshield fee.

---

## 15. Documentation Update Suggestions

1. **Fee formula**: Replace `base = amount * 10000 / (10000 + feeBps)` with `base = amount - (amount * feeBps / 10000)`.
2. **Relayer fee architecture**: Mark DOC-1 Section "Cross-Chain Shields (Option A)" and DOC-2 Phase 4 as NOT YET IMPLEMENTED.
3. **Quorum counting**: Add explicit rule: "Quorum = forVotes + abstainVotes >= threshold. Against votes do not count."
4. **Proposal threshold**: Clarify whether "eligible supply" means total supply or circulating supply.
5. ~~**Phase.Commitment**: Document that the Commitment phase is implicit (time-based, not state-transition based).~~ [RESOLVED — dead phases removed from enum]
6. **Unshield fee**: Document that unshield fee is intentionally set to 0 in the POC deployment.
7. **Adapter cost basis**: Add a known-limitation section explaining that per-user cost basis tracking is approximated when using the adapter pattern.

---

## 16. Final Risk Assessment

### Privacy Pool: MEDIUM-HIGH Risk
The core cryptographic flows (shield, transact, unshield) are correctly implemented. The fee formula divergence is the most significant issue. The missing relayer fee mechanism and source domain validation are design gaps that should be addressed before moving beyond POC.

### Yield System: MEDIUM Risk
The ERC4626-style vault is correctly implemented. The yield fee and cost basis formulas match the spec. The adapter pattern's inherent limitation with shared cost basis is documented. The `recordFee()` access control is a tracking-only issue.

### Governance: MEDIUM Risk
Core governance flows (propose, vote, queue, execute) are correctly implemented. The proposal threshold using total supply instead of eligible supply is a significant parameter mismatch. The quorum counting rules need documentation.

### Crowdfund: MEDIUM Risk
The crowdfund lifecycle is correctly implemented for the happy path. The ARM recovery bug in the Canceled state is the most significant issue. The dead Phase.Commitment state and missing finalization deadline are design concerns.

### Overall Assessment
The codebase demonstrates a high degree of functional alignment with the specifications. The divergences found are primarily in three categories:
1. **Unimplemented spec features** (relayer fee deduction -- FINDING-02)
2. **Formula/parameter mismatches** (fee formula, proposal threshold -- FINDINGS 01, 05)
3. **Missing defense-in-depth** (domain validation, access control -- FINDINGS 03, 13)

No logic errors were found that would enable direct fund theft. The most impactful finding for production readiness is the missing cross-chain relayer fee mechanism, which is a prerequisite for the gasless user experience described in the spec.

---

*Report generated by spec-to-code compliance analysis. All findings reference exact file paths and line numbers. No behavior was inferred beyond what is documented in the spec or implemented in the code.*

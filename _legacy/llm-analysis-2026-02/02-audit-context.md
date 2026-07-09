# Architectural Context: Railgun CCTP POC

**Analyzed**: 2026-02-19
**Method**: Deep per-module analysis (audit-context-building skill)
**Scope**: All contracts in `contracts/`

---

## 1. System Architecture

### Module Architecture (Hub Pool)

```
External Caller
       │
       ▼
┌─────────────────────────┐
│    PrivacyPool.sol      │  ← Router (holds all state)
│    (PrivacyPoolStorage) │
└────┬───────┬───────┬────┘
     │delegatecall   │
     ▼       ▼       ▼
  Shield  Transact  Merkle   Verifier
  Module  Module    Module   Module
```

**Key patterns:**
- All modules inherit `PrivacyPoolStorage` — same storage layout, no additional state variables
- Three distinct call patterns:
  - **A**: External → Router → delegatecall → Module (shield, transact, atomicCrossChainUnshield)
  - **B**: Module → address(this) → Router → delegatecall → Module (merkle insertions)
  - **C**: Module → address(this) → Router view function (SNARK verification)
- `msg.sender` during delegatecall = original external caller
- Storage context during delegatecall = PrivacyPool

### Cross-Chain Architecture

```
Client Chain                          Hub Chain
┌──────────────────┐    CCTP V2    ┌──────────────────┐
│ PrivacyPoolClient│ ──────────→   │   PrivacyPool    │
│   (burn USDC)    │               │ (mint → shield)  │
│                  │   ←────────── │ (burn → unshield) │
│ (mint → forward) │               │                  │
└──────────────────┘               └──────────────────┘
```

---

## 2. Trust Boundaries

### Privacy Pool Trust Model

| Actor | Trust Level | Powers |
|-------|------------|--------|
| Any user | Untrusted | shield, transact, atomicCrossChainUnshield, crossChainShield |
| Owner | Full trust | setTestingMode, setVerificationKey, setFees, setTreasury, setRemotePool |
| TokenMessenger (CCTP) | Semi-trusted | handleReceiveFinalizedMessage (only caller allowed) |
| Adapter (yield) | Semi-trusted | privilegedShieldCaller (fee bypass), bound by SNARK proof |

### Governance Trust Chain

```
ARM Holders (0.1% threshold) → Proposal
  → Voters (locked ARM at snapshot) → Vote
    → TimelockController (2-4 day delay) → Execute
      → ArmadaTreasuryGov (distributions, claims, steward)
      → TreasurySteward (elected, 180-day term, veto window)
```

### Yield System Trust Chain

```
Untrusted Caller → ArmadaYieldAdapter (bound by SNARK proof)
  → PrivacyPool (verifies proof, transfers tokens)
  → ArmadaYieldVault (deposits/redeems, 10% yield fee)
    → Aave V4 Spoke (underlying yield source)
  → ArmadaTreasury (fee collection — NO access control on recordFee)
```

---

## 3. Critical Data Flows

### Shield Flow (Local)
1. User calls `shield(ShieldRequest[])` with USDC
2. ShieldModule: validate commitment preimage, compute fee, transfer USDC in
3. Hash commitment via Poseidon, insert into merkle tree
4. Emit `Shield` event with ciphertext

### Transact Flow (Unshield)
1. User calls `transact(Transaction[])` with SNARK proof
2. TransactModule: validate proof, check adaptContract == msg.sender
3. Nullify spent inputs, accumulate new commitments
4. Transfer USDC out to recipient (from npk field)
5. Insert new commitments into merkle tree

### Cross-Chain Shield (Client → Hub)
1. Client: user calls `crossChainShield()` → burns USDC via CCTP
2. CCTP attestation → relayer calls `receiveMessage` on Hub
3. Hub: `handleReceiveFinalizedMessage` → `_processInternalShield`
4. Creates commitment in merkle tree for minted USDC

### Cross-Chain Unshield (Hub → Client)
1. Hub: user calls `atomicCrossChainUnshield()` with SNARK proof
2. Verify proof, nullify inputs, burn USDC via CCTP
3. Client: `handleReceiveFinalizedMessage` → forward USDC to recipient

### Yield Lend Flow
1. Caller calls `adapter.lendAndShield(transaction, npk, ciphertext)`
2. Verify adaptContract == address(adapter) and adaptParams match
3. Unshield USDC from privacy pool → adapter holds USDC
4. Deposit USDC to vault → adapter receives ayUSDC shares
5. Shield ayUSDC shares to user's npk in privacy pool

---

## 4. Key Invariants

### Privacy Pool
| ID | Invariant |
|----|-----------|
| INV-1 | Every merkle leaf is backed by a token transfer in or CCTP mint |
| INV-2 | Nullifiers can only be spent once per (treeNumber, nullifier) |
| INV-3 | `rootHistory` is append-only; roots are never invalidated |
| INV-4 | `merkleRoot` always equals the correct Poseidon tree root |
| INV-5 | `treeNumber` is monotonically non-decreasing |
| INV-6 | Storage layout is identical across all modules (PrivacyPoolStorage) |
| INV-7 | SNARK proofs verified before any state mutation (unless testingMode) |
| INV-8 | `initialized` transitions false→true exactly once |

### Yield System
| ID | Invariant |
|----|-----------|
| INV-Y1 | Adapter holds zero tokens between atomic operations |
| INV-Y2 | Every lendAndShield produces exactly one unshield + one shield |
| INV-Y3 | adaptParams binding prevents adapter from changing shield destination |
| INV-Y4 | Vault totalSupply == sum of all balanceOf |
| INV-Y5 | `totalPrincipal` tracks aggregate deposit principal (may drift due to rounding) |

### Governance
| ID | Invariant |
|----|-----------|
| INV-G1 | ARM total supply is constant at 100M * 1e18 |
| INV-G2 | One vote per address per proposal |
| INV-G3 | Proposal state transitions are monotonic (never backward) |
| INV-G4 | Steward spend capped at 1% of current balance per 30-day period |
| INV-G5 | Claims: exercised + new_amount <= total_amount |

### Crowdfund
| ID | Invariant |
|----|-----------|
| INV-C1 | allocUsdc + refundUsdc == committed (exact per participant) |
| INV-C2 | Reserve BPS sum to 10000 |
| INV-C3 | USDC balance >= totalCommitted (at all times before finalize) |
| INV-C4 | Per-participant cap enforced per hop |

---

## 5. Structural Observations & Risk Areas

### HIGH: Source Domain Not Validated on Hub

`PrivacyPool.handleReceiveFinalizedMessage` does NOT check `remoteDomain` against `remotePools`. The Hub accepts shield messages from any CCTP source domain. The Client correctly checks `remoteDomain == hubDomain`.

**Impact**: If an attacker can send a CCTP message from an unexpected domain, they could create commitments on the Hub. Mitigated by CCTP's own message authentication.

### HIGH: `setTestingMode(bool)` — Complete Proof Bypass

Owner can disable ALL SNARK verification at any time. No compile-time or deployment-time restriction. Labeled "POC ONLY" but present in deployable code.

### HIGH: `VERIFICATION_BYPASS` at `tx.origin == 0xdead`

Both `verify()` implementations return `true` when `tx.origin == 0xdead`. This is the burn address — no known private key exists. Used for gas estimation. If eth_estimateGas results are trusted for verification, this could be exploited.

### MEDIUM: `safeApprove` Inconsistency in CCTP Burns

`PrivacyPoolClient.crossChainShield` resets allowance to 0 before setting new value. `TransactModule._executeCCTPBurn` does NOT reset. If a prior burn's allowance wasn't fully consumed, `safeApprove` reverts.

### MEDIUM: Adapter as Shared Identity for Vault

All privacy pool users interact with the vault through the adapter's address. The vault sees a single depositor. Cost basis tracking (`userCostBasisPerShare[adapter]`) is reset on each `lendAndShield` (since adapter balance returns to 0 between operations). The yield fee on any `redeemAndShield` uses the cost basis from the most recent `lendAndShield`, regardless of which user is redeeming.

### MEDIUM: `uint120` Truncation Without Explicit Check

- Adapter L209: `uint120(shares)` — silent truncation if shares > type(uint120).max
- Adapter L285: `uint120(assets)` — same risk
- Client L136: `uint120(amount)` — same risk
- Practically safe (USDC 6 decimals, max ~1.3e30) but no explicit check

### MEDIUM: `recordFee()` / `onTokenTransfer()` No Access Control

`ArmadaTreasury` functions inflate `totalCollected` without verification. Tracking-only, no fund loss.

### MEDIUM: Quorum Sensitivity to Treasury Balance

`ArmadaGovernor.quorum()` reads live `armToken.balanceOf(treasuryAddress)`. Distributing ARM from treasury during voting changes the quorum retroactively.

### MEDIUM: ARM Recovery After Crowdfund Cancellation

If sale is canceled, `withdrawUnallocatedArm()` requires `phase == Finalized`. No mechanism to recover ARM tokens in the Canceled state. Tokens are permanently locked.

### MEDIUM: No Finalization Deadline in Crowdfund

Admin can delay `finalize()` indefinitely after `commitmentEnd`, locking participant USDC with no claim or refund mechanism.

### LOW: Steward Action Delay Retroactivity

Changing `actionDelay` via governance affects ALL pending actions (read at execution time, not proposal time). Setting delay to 0 eliminates the veto window entirely.

### LOW: Steward Pending Actions Survive Election

Removing a steward doesn't cancel their pending actions. A newly elected steward can execute old steward's actions.

### LOW: No Ownership Transfer for PrivacyPool/Client

Owner set once during `initialize()`, cannot be changed. Key loss = permanent lockout.

### ~~LOW: `Phase.Commitment` Dead State in Crowdfund~~ [RESOLVED]

~~The `Phase` enum includes `Commitment` (value 2) but no code ever sets `phase = Phase.Commitment`.~~

**Resolution**: Phase model simplified to `{Active, Finalized, Canceled}`. The dead `Setup`, `Invitation`, and `Commitment` enum values were removed. Invites and commits happen concurrently during the Active phase.

### LOW: `withdrawProceeds()` Lacks Reentrancy Guard

No `nonReentrant` modifier. Admin-only + CEI pattern mitigates, but pattern inconsistency.

---

## 6. Fee Bypass Mechanisms

| Mechanism | Where | Who Bypasses |
|-----------|-------|--------------|
| `privilegedShieldCallers[msg.sender]` | ShieldModule L218 | Yield adapter (local shields) |
| `privilegedShieldCallers[msg.sender]` | ShieldModule L132 | TokenMessenger (cross-chain shields) |
| `privilegedShieldCallers[recipient]` | TransactModule L347 | Adapter as recipient (unshields) |
| `shieldFee == 0` / `unshieldFee == 0` | Default state | Everyone (POC default) |
| `treasury == address(0)` | Fee transfer skipped | Fee still deducted but not sent |

**Note**: Fee bypass on unshields checks the RECIPIENT, not the caller. On shields, it checks the CALLER.

---

## 7. Conversion Formulas

### Vault
- `shares = (assets * totalSupply) / totalAssets`
- `assets = (shares * totalAssets) / totalSupply`
- Cost basis first deposit: `(assets * 1e18) / shares`
- Cost basis subsequent: `(oldBasis * oldShares + assets * 1e18) / (oldShares + newShares)`
- Yield fee: `(yield * 1000) / 10000 = yield / 10` (10%)

### Crowdfund Allocation
- Under-subscribed: `allocUsdc = committed`, `allocArm = (committed * 1e18) / ARM_PRICE`
- Over-subscribed: `allocUsdc = (committed * finalReserves[hop]) / finalDemands[hop]`
- Over-subscribed ARM: `(committed * finalReserves[hop] * 1e18) / (finalDemands[hop] * ARM_PRICE)`
- Refund: `committed - allocUsdc` (exact)

### Governance Quorum
- `eligibleSupply = armToken.totalSupply() - armToken.balanceOf(treasuryAddress)`
- `quorum = (eligibleSupply * quorumBps) / 10000`

---

## 8. Open Questions for Further Investigation

1. **Hub source domain validation**: Is the missing remoteDomain check intentional? Does CCTP's own auth suffice?
2. **safeApprove residual allowance**: Can `depositForBurnWithHook` leave residual allowance?
3. **Fee on cross-chain shields**: Is `tokenMessenger` intended to be in `privilegedShieldCallers`?
4. **Poseidon library stubs**: Are deployed library addresses verified against circomlib?
5. **Cost basis accuracy under adapter pattern**: Is per-user yield tracking needed or is the aggregate approach intentional?
6. **Steward action target restrictions**: Can steward propose actions targeting contracts other than treasury?
7. **Quorum mutability during voting**: Is dynamic quorum (based on live treasury balance) intended?
8. **Action delay set to zero**: Should there be a minimum action delay enforced?
9. **Crowdfund ARM recovery**: How are ARM tokens recovered after cancellation?
10. **Tree rollover with stale proofs**: Do proofs against old tree roots remain valid after rollover?

---

## Files Analyzed

| Subsystem | Contracts | Agent |
|-----------|-----------|-------|
| Privacy Pool | PrivacyPool, ShieldModule, TransactModule, MerkleModule, VerifierModule, PrivacyPoolClient, CCTPTypes, PrivacyPoolStorage | Privacy Pool agent |
| Yield | ArmadaYieldAdapter, ArmadaYieldVault, ArmadaTreasury, YieldAdaptParams, MockAaveSpoke | Yield System agent |
| Governance | ArmadaGovernor, VotingLocker, ArmadaTreasuryGov, TreasurySteward, ArmadaToken, IArmadaGovernance | Governance agent |
| Crowdfund | ArmadaCrowdfund, IArmadaCrowdfund | Crowdfund agent |

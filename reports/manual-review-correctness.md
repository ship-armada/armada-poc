# Manual Review: Correctness Checklist

**Date:** 2025-02-17  
**Scope:** Overflow, division-by-zero, rounding, state machine

---

## ArmadaCrowdfund

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+ built-in checks. Bounds in `_computeAllocation` (committed, reserve, demand) prevent overflow; Halmos proven for alloc+refund=committed. |
| Division-by-zero | ✅ | `finalDemands[hop]` set from `hopStats[h].totalCommitted`; over-subscribed case has `demand > 0`. Under-subscribed uses `ARM_PRICE` (constant 1e6). |
| Rounding | ✅ | Pro-rata: `(committed * reserve) / demand` — rounds down; refund = committed - allocUsdc. Formally proven. Hop-level `totalAllocArm` uses same formula. |
| State machine | ✅ | Phase: Active → Finalized/Canceled. Direct `require(phase == Phase.Active)` guards enforce. `finalize()` sets phase once. |

**Known:** `finalize()` O(n) over `participantList` — not used; allocations computed lazily in `claim()`. Documented in TESTING_NEXT_STEPS.

---

## ArmadaYieldVault

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+. `totalPrincipal` can exceed `totalAssets` by 1 wei (cost-basis rounding) — documented in YieldInvariant; invariant relaxed. |
| Division-by-zero | ✅ | `_convertToShares`: `supply == 0` returns assets; `total == 0` returns assets. `_convertToAssets`: `supply == 0` returns shares. `BPS_DENOMINATOR` = 10000. |
| Rounding | ⚠️ | Cost-basis weighted average: `(oldBasis * oldShares + assets * PRECISION) / (oldShares + newShares)` — rounds down. `principalPortion` clamped to `totalPrincipal` (L259-261) prevents underflow. |
| State machine | ✅ | No phase; deposit/redeem are independent. |

---

## ArmadaYieldAdapter

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+. Amounts from vault/user. |
| Division-by-zero | N/A | No divisions; delegates to vault. |
| Rounding | N/A | Pass-through. |
| State machine | ✅ | No phase. |

---

## VotingLocker

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+. `newBalance = oldBalance + amount`; `oldBalance >= amount` for unlock. |
| Division-by-zero | N/A | No divisions. |
| Rounding | N/A | Checkpoint amounts are exact. |
| State machine | ✅ | Lock/unlock independent. Binary search correctness proven by Halmos. |

---

## ArmadaGovernor

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+. Vote weights from checkpoint (uint224). |
| Division-by-zero | ✅ | `quorum`: `eligibleSupply = totalSupply - treasuryBalance`; if treasury holds all, eligibleSupply=0 → quorum=0. `10000` in denominator. |
| Rounding | ✅ | Quorum/proposal threshold use bps; rounds down. |
| State machine | ✅ | Proposal: Pending → Active → Defeated/Succeeded → Queued → Executed. `state()` enforces. `block.number - 1` for snapshot: safe (proposal created in same block; snapshot is prior block). |

**Note:** `_checkProposalThreshold` uses `block.number - 1`. At block N, proposer's balance at N-1 is used. Correct for snapshot-before-proposal pattern.

---

## ArmadaTreasuryGov

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+. |
| Division-by-zero | ✅ | `monthlyBudget = (treasuryBalance * STEWARD_BUDGET_BPS) / 10000`; treasuryBalance can be 0 → budget=0, require fails. |
| Rounding | ✅ | Steward budget rounds down. Claim exercise: `c.exercised + amount <= c.amount`. |
| State machine | ✅ | Claims: created → exercised (partial or full). |

---

## PrivacyPool / Modules

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | Solidity 0.8+. Fee math uses uint120; value clamped. |
| Division-by-zero | ✅ | `_getFee`: `feeBP == 0` returns (amount, 0). `feeBP < 10000` for exclusive; `BASIS_POINTS - feeBP > 0`. |
| Rounding | ✅ | Fee: inclusive `base = amount - (amount * feeBP) / 10000`; exclusive `fee = (10000 * amount) / (10000 - feeBP) - amount`. Halmos proven for conservation. |
| State machine | ✅ | `initialized` one-time. Merkle: insertLeaves updates root; tree rollover when full. |

---

## MerkleModule

| Check | Status | Notes |
|-------|--------|-------|
| Overflow | ✅ | `nextLeafIndex + count`; `2 ** TREE_DEPTH` = 65536. Bounded. |
| Division-by-zero | N/A | `levelInsertionIndex >> 1` (bit shift). |
| Rounding | ✅ | `>> 1` is floor division. |
| State machine | ✅ | nextLeafIndex monotonic; tree rollover creates new tree. |

---

## Summary

- **Overflow:** All contracts use Solidity 0.8+; no manual overflow checks needed.
- **Division-by-zero:** Guards present (zero checks, constant denominators).
- **Rounding:** Documented; yield vault `totalPrincipal` vs `totalAssets` edge case accepted.
- **State machine:** Phase transitions and invariants respected.

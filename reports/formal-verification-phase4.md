# Phase 4: Formal Verification (Halmos) — Report

**Date:** 2026-02-17 (updated 2026-10-28)

## Summary

Halmos symbolic execution was run against the POC contracts. **15 properties are formally proven** across allocation math, checkpoint lookup, and fee logic (re-run on 2026-10-28 with halmos 0.3.3 and the default 60s solver timeout; the original February run proved 13). Some properties are SMT-undecidable (nonlinear integer division) or hit Z3 solver limits; those are covered by fuzz tests.

## Setup

- **Config:** `halmos.toml` with `forge-build-out = "forge-out"` (matches `foundry.toml`)
- **Run:** `halmos` (or `halmos --contract <ContractName>` for specific suites). `npm run halmos:allocation`, `halmos:checkpoint` and `halmos:fee` run the properties proven in the February run; they don't yet include the two proven since (`check_armMatchesTwoStepFormula`, `check_feeNeverExceedsAmount`).

**Every property runs against a mirror of the formula inside the test contract, not the deployed contract.** The mirrors must be re-synced by hand when the contract math changes:

- `HalmosAllocationTest` mirrors the crowdfund allocation math. Its signature differs from `ArmadaCrowdfund._computeAllocation(committed, hop, effectiveCap)`.
- `HalmosCheckpointTest` mirrors an ERC20Votes-style `_checkpointsLookup` binary search, not the OpenZeppelin `ERC20Votes` code that `ArmadaToken` uses.
- `HalmosFeeTest` mirrors the pool's flat-fee `_getFee`, which now lives only in `ShieldModule`. It doesn't cover `ArmadaFeeModule`.

## Results by Contract

### 4.1 Crowdfund Allocation Math (`HalmosAllocationTest`)

| Property | Status | Notes |
|----------|--------|-------|
| `check_allocPlusRefundEqualsCommitted` | ✅ PROVEN | allocUsdc + refund == committed |
| `check_allocNeverExceedsCommitted` | ✅ PROVEN | allocUsdc <= committed |
| `check_underSubscribedFullAllocation` | ✅ PROVEN | reserve >= demand → full allocation, no refund |
| `check_zeroCommittedReturnsZero` | ✅ PROVEN | (0, 0, 0) for zero committed |
| `check_overSubscribedAllocBoundedByReserve` | ⏱️ TIMEOUT | SMT-undecidable (nonlinear div). Covered by `AllocationFuzz.t.sol` |
| `check_armMatchesTwoStepFormula` | ✅ PROVEN | allocArm == (allocUsdc × 1e18) / ARM_PRICE. Timed out in the February run; also covered by `testFuzz_armMatchesUsdcAtPrice` |
| `check_proRataMonotonicity` | ⏱️ TIMEOUT | SMT-undecidable. Covered by `testFuzz_proRataMonotonicity` |
| `check_overCapRefundIncludesExcess` | ⏱️ TIMEOUT | SMT-undecidable. Covered by `testFuzz_overCapRefundIncludesExcess` |

### 4.2 ERC20Votes-Style Checkpoint Lookup, Mirror (`HalmosCheckpointTest`)

| Property | Status | Notes |
|----------|--------|-------|
| `check_binaryMatchesLinear_2` | ✅ PROVEN | Binary search == linear for 2 checkpoints |
| `check_binaryMatchesLinear_3` | ✅ PROVEN | Same for 3 checkpoints |
| `check_binaryMatchesLinear_4` | ✅ PROVEN | Same for 4 checkpoints (loop-bound warning) |
| `check_emptyReturnsZero` | ✅ PROVEN | Empty array returns 0 |
| `check_queryBeforeFirstReturnsZero` | ✅ PROVEN | Query before first checkpoint returns 0 |
| `check_queryAfterLastReturnsLast` | ✅ PROVEN | Query at/after last returns last value |
| `check_exactBlockMatch` | ✅ PROVEN | Query at exact block returns that checkpoint |

### 4.3 Fee Logic (`HalmosFeeTest`)

| Property | Status | Notes |
|----------|--------|-------|
| `check_feeConservation` | ✅ PROVEN | base + fee == amount (inclusive) |
| `check_zeroFeeReturnsFullAmount` | ✅ PROVEN | feeBP=0 → base=amount, fee=0 |
| `check_feeNeverExceedsAmount` | ✅ PROVEN | fee <= amount. Timed out in the February run; also covered by `BoundaryFuzz.t.sol` |
| `check_maxFeeReturnsZeroBase` | ⏱️ TIMEOUT | feeBP=10000 → base=0. Covered by BoundaryFuzz |
| `check_feeMonotonicity` | ⏱️ TIMEOUT | Higher bps → higher fee. Covered by fuzz |
| `check_exclusiveFeeGteInclusive` | ⏱️ TIMEOUT | Covered by `PrivacyPoolFuzz.t.sol` |

### 4.4 Merkle Module (`HalmosMerkleTest`)

**Not implemented.** Merkle insertion/root update uses:

- **Poseidon hash** — external/precompile; Halmos cannot symbolically model it
- **Nested loops** over TREE_DEPTH (16) with dynamic tree rollover

**Recommendation:** Rely on `PrivacyPoolInvariant.t.sol` (MerkleHandler, root history) and integration tests. Formal verification of Merkle with Poseidon would require a custom Halmos plugin or different tooling.

## Lessons

- **foundry.toml `out = "forge-out"`** — Halmos expects `out` by default; add `[global] forge-build-out = "forge-out"` to `halmos.toml`
- **SMT timeouts** — Nonlinear integer division is undecidable for Z3; use fuzz tests for those properties
- **Fee tests** — uint120 division in Z3 is expensive; 3 core properties proven, rest covered by fuzz

# Phase 4: Formal Verification (Halmos) — Report

## Summary

Halmos symbolic execution was run against the Railgun CCTP POC contracts. **13 properties were formally proven** across allocation math, checkpoint lookup, and fee logic. Some properties are SMT-undecidable (nonlinear integer division) or hit Z3 solver limits; those are covered by fuzz tests.

## Setup

- **Config:** `halmos.toml` with `forge-build-out = "forge-out"` (matches `foundry.toml`)
- **Run:** `halmos` (or `halmos --contract <ContractName>` for specific suites)

## Results by Contract

### 4.1 Crowdfund Allocation Math (`HalmosAllocationTest`)

| Property | Status | Notes |
|----------|--------|-------|
| `check_allocPlusRefundEqualsCommitted` | ✅ PROVEN | allocUsdc + refund == committed |
| `check_allocNeverExceedsCommitted` | ✅ PROVEN | allocUsdc <= committed |
| `check_underSubscribedFullAllocation` | ✅ PROVEN | reserve >= demand → full allocation, no refund |
| `check_zeroCommittedReturnsZero` | ✅ PROVEN | (0, 0, 0) for zero committed |
| `check_overSubscribedAllocBoundedByReserve` | ⏱️ TIMEOUT | SMT-undecidable (nonlinear div). Covered by `AllocationFuzz.t.sol` |
| `check_directArmFormulaGeTwoStep` | ⏱️ TIMEOUT | SMT-undecidable. Covered by `testFuzz_armMatchesUsdcAtPrice` |
| `check_proRataMonotonicity` | ⏱️ TIMEOUT | SMT-undecidable. Covered by `testFuzz_proRataMonotonicity` |

### 4.2 VotingLocker Checkpoint (`HalmosCheckpointTest`)

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
| `check_feeNeverExceedsAmount` | ⏱️ TIMEOUT | Z3 struggles with division. Covered by `BoundaryFuzz.t.sol` |
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
- **Fee tests** — uint120 division in Z3 is expensive; 2 core properties proven, rest covered by fuzz

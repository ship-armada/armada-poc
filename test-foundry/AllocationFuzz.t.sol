// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

/// @title AllocationFuzzTest — Stateless fuzz tests for crowdfund allocation math
/// @dev Tests the core allocation formula in isolation to prove properties hold
///      for all possible inputs (committed, reserve, demand).
contract AllocationFuzzTest is Test {
    uint256 constant ARM_PRICE = 1e6; // $1.00 per ARM

    /// @dev Mirror of ArmadaCrowdfund._computeAllocation
    function _computeAllocation(
        uint256 committed,
        uint256 finalReserve,
        uint256 finalDemand,
        uint256 effectiveCap
    ) internal pure returns (uint256 allocArm, uint256 allocUsdc, uint256 refundUsdc) {
        if (committed == 0) return (0, 0, 0);
        if (finalDemand == 0) return (0, 0, 0); // impossible in practice, but safe

        // Cap first, matching contract behavior
        uint256 cappedCommitted = committed < effectiveCap ? committed : effectiveCap;

        if (finalDemand <= finalReserve) {
            // Under-subscribed: full allocation of capped amount
            allocUsdc = cappedCommitted;
        } else {
            // Over-subscribed: pro-rata of capped amount
            allocUsdc = (cappedCommitted * finalReserve) / finalDemand;
        }
        // ARM uses two-step formula matching the contract
        allocArm = (allocUsdc * 1e18) / ARM_PRICE;
        // Refund = everything not allocated (including over-cap excess)
        refundUsdc = committed - allocUsdc;
    }

    /// @notice allocUsdc + refundUsdc == committed (exact, no dust created or destroyed)
    function testFuzz_allocPlusRefundEqualsCommitted(
        uint256 committed,
        uint256 reserve,
        uint256 demand,
        uint256 effectiveCap
    ) public pure {
        // Bound inputs to realistic ranges
        committed = bound(committed, 1, 15_000 * 1e6); // max hop-0 cap
        reserve = bound(reserve, 1, 1_800_000 * 1e6);  // max sale size
        demand = bound(demand, committed, 2_000_000 * 1e6); // demand >= committed (participant is part of demand)
        effectiveCap = bound(effectiveCap, 1, committed * 3); // variety: sometimes below, sometimes above

        (, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(committed, reserve, demand, effectiveCap);

        assertEq(allocUsdc + refundUsdc, committed, "alloc + refund != committed");
    }

    /// @notice allocUsdc <= committed (allocation never exceeds commitment)
    function testFuzz_allocNeverExceedsCommitted(
        uint256 committed,
        uint256 reserve,
        uint256 demand,
        uint256 effectiveCap
    ) public pure {
        committed = bound(committed, 1, 15_000 * 1e6);
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        demand = bound(demand, 1, 2_000_000 * 1e6);
        effectiveCap = bound(effectiveCap, 1, committed * 3);

        (, uint256 allocUsdc, ) = _computeAllocation(committed, reserve, demand, effectiveCap);

        assertLe(allocUsdc, committed, "allocUsdc > committed");
    }

    /// @notice When demand > reserve, allocUsdc <= reserve (single participant can't drain reserve)
    /// @dev More precisely: allocUsdc <= (committed * reserve) / demand <= reserve
    function testFuzz_allocNeverExceedsReserve(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        committed = bound(committed, 1, 15_000 * 1e6);
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        // In the real system, demand >= committed (demand is sum of ALL commitments at a hop)
        demand = bound(demand, committed, 2_000_000 * 1e6);

        if (demand <= reserve) return; // skip under-subscribed cases

        (, uint256 allocUsdc, ) = _computeAllocation(committed, reserve, demand, type(uint256).max);

        assertLe(allocUsdc, reserve, "allocUsdc > reserve when over-subscribed");
    }

    /// @notice When demand <= reserve, allocUsdc == committed (full allocation)
    function testFuzz_underSubscribedFullAllocation(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        committed = bound(committed, 1, 15_000 * 1e6);
        demand = bound(demand, committed, 1_000_000 * 1e6);
        reserve = bound(reserve, demand, 1_800_000 * 1e6); // under-subscribed: reserve >= demand

        // No cap: full allocation expected
        (, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(committed, reserve, demand, type(uint256).max);

        assertEq(allocUsdc, committed, "Under-subscribed: allocUsdc != committed");
        assertEq(refundUsdc, 0, "Under-subscribed: refund should be 0");
    }

    /// @notice ARM allocation matches USDC allocation at ARM_PRICE rate (two-step formula)
    function testFuzz_armMatchesUsdcAtPrice(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        committed = bound(committed, 1, 15_000 * 1e6);
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        demand = bound(demand, committed, 2_000_000 * 1e6);

        // No cap for this test — focus on ARM/USDC relationship
        (uint256 allocArm, uint256 allocUsdc, ) = _computeAllocation(committed, reserve, demand, type(uint256).max);

        // Two-step formula: allocArm = (allocUsdc * 1e18) / ARM_PRICE
        uint256 expectedArm = (allocUsdc * 1e18) / ARM_PRICE;
        assertEq(allocArm, expectedArm, "ARM should equal (allocUsdc * 1e18) / ARM_PRICE");
    }

    /// @notice Sum-of-parts: for N participants in an over-subscribed hop,
    ///         sum(allocUsdc_i) <= reserve (no more than reserve is allocated)
    function testFuzz_sumOfPartsNeverExceedsReserve(
        uint256 seed,
        uint8 numParticipants
    ) public pure {
        numParticipants = uint8(bound(numParticipants, 2, 50));
        uint256 reserve = 840_000 * 1e6; // hop-0 reserve at BASE_SALE

        // Generate participant commitments
        uint256 totalDemand = 0;
        uint256[] memory commitments = new uint256[](numParticipants);

        for (uint256 i = 0; i < numParticipants; i++) {
            // Deterministic pseudo-random amounts from seed
            uint256 amount = (uint256(keccak256(abi.encode(seed, i))) % (15_000 * 1e6)) + 1;
            commitments[i] = amount;
            totalDemand += amount;
        }

        // Ensure over-subscribed
        if (totalDemand <= reserve) return;

        // Compute sum of allocations
        uint256 sumAllocUsdc = 0;
        for (uint256 i = 0; i < numParticipants; i++) {
            (, uint256 allocUsdc, ) = _computeAllocation(commitments[i], reserve, totalDemand, type(uint256).max);
            sumAllocUsdc += allocUsdc;
        }

        assertLe(sumAllocUsdc, reserve, "Sum of allocations exceeds reserve");
    }

    /// @notice Allocation with zero committed returns all zeros
    function testFuzz_zeroCommittedReturnsZero(uint256 reserve, uint256 demand) public pure {
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        demand = bound(demand, 1, 2_000_000 * 1e6);

        (uint256 allocArm, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(0, reserve, demand, type(uint256).max);

        assertEq(allocArm, 0);
        assertEq(allocUsdc, 0);
        assertEq(refundUsdc, 0);
    }

    /// @notice Pro-rata scaling is monotonic: if A committed more than B, A gets at least as much
    function testFuzz_proRataMonotonicity(
        uint256 commitA,
        uint256 commitB,
        uint256 reserve,
        uint256 demand
    ) public pure {
        commitA = bound(commitA, 1, 15_000 * 1e6);
        commitB = bound(commitB, 1, commitA); // B <= A
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        demand = bound(demand, commitA, 2_000_000 * 1e6);

        (, uint256 allocA, ) = _computeAllocation(commitA, reserve, demand, type(uint256).max);
        (, uint256 allocB, ) = _computeAllocation(commitB, reserve, demand, type(uint256).max);

        assertGe(allocA, allocB, "Larger commitment got less allocation");
    }

    /// @notice Over-cap commits: refund includes at least the excess above cap
    function testFuzz_overCapRefundIncludesExcess(
        uint256 committed,
        uint256 effectiveCap,
        uint256 reserve,
        uint256 demand
    ) public pure {
        committed = bound(committed, 2, 15_000 * 1e6);
        effectiveCap = bound(effectiveCap, 1, committed - 1); // committed > cap
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        demand = bound(demand, committed, 2_000_000 * 1e6);

        (, , uint256 refundUsdc) = _computeAllocation(committed, reserve, demand, effectiveCap);

        uint256 excess = committed - effectiveCap;
        assertGe(refundUsdc, excess, "Refund should include at least the over-cap excess");
    }
}

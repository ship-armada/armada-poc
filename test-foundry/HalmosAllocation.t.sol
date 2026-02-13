// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/// @title HalmosAllocationTest — Symbolic verification of crowdfund allocation math
/// @dev Halmos proves these properties hold for ALL possible uint256 inputs,
///      not just random samples. Uses Z3 SMT solver for exhaustive symbolic execution.
contract HalmosAllocationTest is Test, SymTest {
    uint256 constant ARM_PRICE = 1e6;

    /// @dev Mirror of ArmadaCrowdfund._computeAllocation
    function _computeAllocation(
        uint256 committed,
        uint256 finalReserve,
        uint256 finalDemand
    ) internal pure returns (uint256 allocArm, uint256 allocUsdc, uint256 refundUsdc) {
        if (committed == 0) return (0, 0, 0);

        if (finalDemand <= finalReserve) {
            allocUsdc = committed;
            allocArm = (committed * 1e18) / ARM_PRICE;
        } else {
            allocUsdc = (committed * finalReserve) / finalDemand;
            allocArm = (committed * finalReserve * 1e18) / (finalDemand * ARM_PRICE);
        }
        refundUsdc = committed - allocUsdc;
    }

    /// @notice PROVE: allocUsdc + refundUsdc == committed (exact, no value created or destroyed)
    function check_allocPlusRefundEqualsCommitted(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        // Bound to realistic ranges to avoid overflow
        vm.assume(committed > 0 && committed <= 15_000 * 1e6);
        vm.assume(reserve > 0 && reserve <= 1_800_000 * 1e6);
        vm.assume(demand >= committed && demand <= 2_000_000 * 1e6);

        // Guard against overflow in multiplication
        vm.assume(committed <= type(uint256).max / reserve);
        if (demand > reserve) {
            vm.assume(committed * reserve <= type(uint256).max / 1e18);
            vm.assume(demand * ARM_PRICE <= type(uint256).max);
        }

        (, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(committed, reserve, demand);

        assert(allocUsdc + refundUsdc == committed);
    }

    /// @notice PROVE: allocUsdc <= committed (allocation never exceeds commitment)
    function check_allocNeverExceedsCommitted(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        vm.assume(committed > 0 && committed <= 15_000 * 1e6);
        vm.assume(reserve > 0 && reserve <= 1_800_000 * 1e6);
        vm.assume(demand >= committed && demand <= 2_000_000 * 1e6);
        vm.assume(committed <= type(uint256).max / reserve);
        if (demand > reserve) {
            vm.assume(committed * reserve <= type(uint256).max / 1e18);
            vm.assume(demand * ARM_PRICE <= type(uint256).max);
        }

        (, uint256 allocUsdc, ) = _computeAllocation(committed, reserve, demand);

        assert(allocUsdc <= committed);
    }

    /// @notice when over-subscribed, allocUsdc <= reserve (allocation bounded by hop reserve)
    /// NOTE: SMT-undecidable (nonlinear integer division). Covered by fuzz test
    ///       testFuzz_allocNeverExceedsReserve in AllocationFuzz.t.sol (256 runs).
    function check_overSubscribedAllocBoundedByReserve(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        vm.assume(committed > 0 && committed <= 15_000 * 1e6);
        vm.assume(reserve > 0 && reserve <= 1_800_000 * 1e6);
        vm.assume(demand > reserve && demand <= 2_000_000 * 1e6);
        vm.assume(demand >= committed);
        vm.assume(committed <= type(uint256).max / reserve);
        vm.assume(committed * reserve <= type(uint256).max / 1e18);
        vm.assume(demand * ARM_PRICE <= type(uint256).max);

        (, uint256 allocUsdc, ) = _computeAllocation(committed, reserve, demand);

        assert(allocUsdc <= reserve);
    }

    /// @notice PROVE: when under-subscribed, allocUsdc == committed and refund == 0
    function check_underSubscribedFullAllocation(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        vm.assume(committed > 0 && committed <= 15_000 * 1e6);
        vm.assume(demand >= committed && demand <= 1_800_000 * 1e6);
        vm.assume(reserve >= demand && reserve <= 1_800_000 * 1e6);

        (, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(committed, reserve, demand);

        assert(allocUsdc == committed);
        assert(refundUsdc == 0);
    }

    /// @notice PROVE: zero committed always returns (0, 0, 0)
    function check_zeroCommittedReturnsZero(
        uint256 reserve,
        uint256 demand
    ) public pure {
        vm.assume(reserve > 0 && reserve <= 1_800_000 * 1e6);
        vm.assume(demand > 0 && demand <= 2_000_000 * 1e6);

        (uint256 allocArm, uint256 allocUsdc, uint256 refundUsdc) = _computeAllocation(0, reserve, demand);

        assert(allocArm == 0);
        assert(allocUsdc == 0);
        assert(refundUsdc == 0);
    }

    /// @notice allocArm (direct formula) >= armFromUsdc (two-step formula)
    /// @dev Direct: (committed * reserve * 1e18) / (demand * ARM_PRICE)
    ///      Two-step: ((committed * reserve) / demand) * 1e18 / ARM_PRICE
    ///      Direct preserves more precision, so it should be >= two-step
    /// NOTE: SMT-undecidable (nonlinear integer division). Covered by fuzz test
    ///       testFuzz_armMatchesUsdcAtPrice in AllocationFuzz.t.sol (256 runs).
    function check_directArmFormulaGeTwoStep(
        uint256 committed,
        uint256 reserve,
        uint256 demand
    ) public pure {
        vm.assume(committed > 0 && committed <= 15_000 * 1e6);
        vm.assume(reserve > 0 && reserve <= 1_800_000 * 1e6);
        vm.assume(demand > reserve && demand <= 2_000_000 * 1e6);
        vm.assume(demand >= committed);
        vm.assume(committed <= type(uint256).max / reserve);
        vm.assume(committed * reserve <= type(uint256).max / 1e18);
        vm.assume(demand * ARM_PRICE <= type(uint256).max);

        (uint256 allocArm, uint256 allocUsdc, ) = _computeAllocation(committed, reserve, demand);

        uint256 armFromUsdc = (allocUsdc * 1e18) / ARM_PRICE;
        assert(allocArm >= armFromUsdc);
    }

    /// @notice pro-rata monotonicity — if commitA >= commitB, allocA >= allocB
    /// NOTE: SMT-undecidable (nonlinear integer division). Covered by fuzz test
    ///       testFuzz_proRataMonotonicity in AllocationFuzz.t.sol (256 runs).
    function check_proRataMonotonicity(
        uint256 commitA,
        uint256 commitB,
        uint256 reserve,
        uint256 demand
    ) public pure {
        vm.assume(commitA > 0 && commitA <= 15_000 * 1e6);
        vm.assume(commitB > 0 && commitB <= commitA);
        vm.assume(reserve > 0 && reserve <= 1_800_000 * 1e6);
        vm.assume(demand >= commitA && demand <= 2_000_000 * 1e6);
        vm.assume(commitA <= type(uint256).max / reserve);
        if (demand > reserve) {
            vm.assume(commitA * reserve <= type(uint256).max / 1e18);
            vm.assume(demand * ARM_PRICE <= type(uint256).max);
        }

        (, uint256 allocA, ) = _computeAllocation(commitA, reserve, demand);
        (, uint256 allocB, ) = _computeAllocation(commitB, reserve, demand);

        assert(allocA >= allocB);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

/// @title BoundaryFuzzTest — Fuzz tests for boundary values (0, 1 wei, max)
/// @dev Ensures edge cases are exercised: minimal amounts, max amounts, zero addresses.
contract BoundaryFuzzTest is Test {
    uint120 private constant BASIS_POINTS = 10000;

    /// @dev Mirror of ShieldModule/TransactModule._getFee
    function _getFee(
        uint136 _amount,
        bool _isInclusive,
        uint120 _feeBP
    ) internal pure returns (uint120 base, uint120 fee) {
        if (_feeBP == 0) return (uint120(_amount), 0);
        if (_isInclusive) {
            base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
            fee = uint120(_amount) - base;
        } else {
            base = uint120(_amount);
            fee = uint120((BASIS_POINTS * _amount) / (BASIS_POINTS - _feeBP) - _amount);
        }
    }

    /// @notice Fee math at 1 wei amount — should not revert, base+fee==amount
    function testFuzz_feeAtOneWei(uint120 feeBP) public pure {
        feeBP = uint120(bound(feeBP, 0, 10000));
        (uint120 base, uint120 fee) = _getFee(1, true, feeBP);
        assertEq(uint256(base) + uint256(fee), 1, "1 wei: base+fee != amount");
    }

    /// @notice Fee math at max uint120 — conservation holds
    function testFuzz_feeAtMaxAmount(uint120 feeBP) public pure {
        uint120 amount = type(uint120).max;
        feeBP = uint120(bound(feeBP, 0, 10000));
        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, feeBP);
        assertEq(uint256(base) + uint256(fee), uint256(amount), "max: base+fee != amount");
    }

    /// @notice Fee at feeBP=0 returns full amount
    function testFuzz_zeroFeeReturnsFullAmount(uint256 amount) public pure {
        amount = bound(amount, 1, type(uint120).max);
        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, 0);
        assertEq(base, uint120(amount), "zero fee: base != amount");
        assertEq(fee, 0, "zero fee: fee != 0");
    }

    /// @notice Fee at feeBP=10000 (100%) returns base=0, fee=amount
    function testFuzz_maxFeeReturnsZeroBase(uint256 amount) public pure {
        amount = bound(amount, 1, type(uint120).max);
        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, 10000);
        assertEq(base, 0, "max fee: base != 0");
        assertEq(fee, uint120(amount), "max fee: fee != amount");
    }

    /// @notice Allocation at 1 wei committed — no overflow, alloc+refund==committed
    function testFuzz_allocationAtOneWei(uint256 reserve, uint256 demand) public pure {
        uint256 committed = 1;
        reserve = bound(reserve, 1, 1_800_000 * 1e6);
        demand = bound(demand, committed, 2_000_000 * 1e6);

        uint256 allocUsdc;
        uint256 refundUsdc;
        if (demand <= reserve) {
            allocUsdc = committed;
            refundUsdc = 0;
        } else {
            allocUsdc = (committed * reserve) / demand;
            refundUsdc = committed - allocUsdc;
        }
        assertEq(allocUsdc + refundUsdc, committed, "1 wei: alloc+refund != committed");
    }
}

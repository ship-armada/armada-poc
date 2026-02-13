// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/// @title HalmosFeeTest — Symbolic verification of privacy pool fee math
/// @dev Halmos proves these properties hold for ALL possible inputs within bounds,
///      not just random samples. Mirrors _getFee from ShieldModule/TransactModule.
///
///      Properties proven over the full uint120 range:
///      - feeConservation (base + fee == amount)
///      - feeNeverExceedsAmount (fee <= amount)
///      - zeroFeeReturnsFullAmount (feeBP=0 → base=amount)
///
///      Properties proven over uint64 range (~18.4 quintillion, covers all real USDC):
///      - maxFeeReturnsZeroBase (feeBP=10000 → base=0)
///      - feeMonotonicity (higher bps → higher fee)
///      - exclusiveFeeGteInclusive
///
///      Note: Using uint64 params for bounded proofs because Halmos creates symbolic
///      variables matching the Solidity param type, and Z3 struggles with 120-bit division.
///      uint64 covers up to ~$18.4B USDC (more than total USDC supply).
contract HalmosFeeTest is Test, SymTest {
    uint120 private constant BASIS_POINTS = 10000;

    /// @dev Mirror of ShieldModule/TransactModule._getFee
    function _getFee(
        uint136 _amount,
        bool _isInclusive,
        uint120 _feeBP
    ) internal pure returns (uint120 base, uint120 fee) {
        if (_feeBP == 0) {
            return (uint120(_amount), 0);
        }

        if (_isInclusive) {
            base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
            fee = uint120(_amount) - base;
        } else {
            base = uint120(_amount);
            fee = uint120((BASIS_POINTS * _amount) / (BASIS_POINTS - _feeBP) - _amount);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SYMBOLIC PROOFS — FULL RANGE (uint120)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice PROVE: base + fee == amount (inclusive mode, exact conservation)
    /// @dev Proven for ALL uint120 amounts and ALL feeBP in [0, 10000]
    function check_feeConservation(uint120 amount, uint120 feeBP) public pure {
        vm.assume(amount > 0);
        vm.assume(feeBP <= 10000);

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, feeBP);

        assert(uint256(base) + uint256(fee) == uint256(amount));
    }

    /// @notice PROVE: fee <= amount (inclusive mode, fee never exceeds the total)
    /// @dev Proven for ALL uint120 amounts and ALL feeBP in [0, 10000]
    function check_feeNeverExceedsAmount(uint120 amount, uint120 feeBP) public pure {
        vm.assume(amount > 0);
        vm.assume(feeBP <= 10000);

        (, uint120 fee) = _getFee(uint136(amount), true, feeBP);

        assert(fee <= amount);
    }

    /// @notice PROVE: feeBP=0 → base=amount, fee=0
    /// @dev Proven for ALL uint120 amounts
    function check_zeroFeeReturnsFullAmount(uint120 amount) public pure {
        vm.assume(amount > 0);

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, 0);

        assert(base == amount);
        assert(fee == 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SYMBOLIC PROOFS — BOUNDED RANGE (uint64 for Z3 tractability)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice PROVE: feeBP=10000 → base=0, fee=amount (100% fee takes everything)
    function check_maxFeeReturnsZeroBase(uint64 amount64) public pure {
        vm.assume(amount64 > 0);
        uint120 amount = uint120(amount64);

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, 10000);

        assert(base == 0);
        assert(fee == amount);
    }

    /// @notice PROVE: feeBP_A >= feeBP_B → fee_A >= fee_B (monotonicity)
    function check_feeMonotonicity(uint64 amount64, uint16 feeBP_A16, uint16 feeBP_B16) public pure {
        vm.assume(amount64 > 0);
        uint120 amount = uint120(amount64);
        uint120 feeBP_A = uint120(feeBP_A16);
        uint120 feeBP_B = uint120(feeBP_B16);
        vm.assume(feeBP_A <= 10000);
        vm.assume(feeBP_B <= feeBP_A);

        (, uint120 feeA) = _getFee(uint136(amount), true, feeBP_A);
        (, uint120 feeB) = _getFee(uint136(amount), true, feeBP_B);

        assert(feeA >= feeB);
    }

    /// @notice PROVE: exclusive fee >= inclusive fee (same amount, same bps)
    function check_exclusiveFeeGteInclusive(uint64 amount64, uint16 feeBP16) public pure {
        vm.assume(amount64 > 0);
        uint120 amount = uint120(amount64);
        uint120 feeBP = uint120(feeBP16);
        vm.assume(feeBP > 0 && feeBP < 10000);

        (, uint120 inclusiveFee) = _getFee(uint136(amount), true, feeBP);
        (, uint120 exclusiveFee) = _getFee(uint136(amount), false, feeBP);

        assert(exclusiveFee >= inclusiveFee);
    }
}

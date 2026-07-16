// ABOUTME: Tests YieldAdaptParams fee binding — the withdraw broadcaster fee (the relayer's 0zk shield
// ABOUTME: destination + amount) is committed into adaptParams so a relayer cannot redirect or inflate it (#312).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/YieldAdaptParams.sol";

contract YieldAdaptParamsFeeTest is Test {
    bytes32 constant NPK = bytes32(uint256(0x1234));
    bytes32 constant SHIELD_KEY = bytes32(uint256(0x5678));
    bytes32 constant FEE_NPK = bytes32(uint256(0xFEE1));
    bytes32 constant FEE_SHIELD_KEY = bytes32(uint256(0xFEE2));
    uint256 constant FEE_AMOUNT = 5_000_000;

    function _bundle(uint256 seed) internal pure returns (bytes32[3] memory b) {
        b[0] = bytes32(seed + 1);
        b[1] = bytes32(seed + 2);
        b[2] = bytes32(seed + 3);
    }

    /// @dev WHY: redeemAndShield verifies the relayer's fee-shield destination + amount against
    ///      adaptParams, so the exact committed values must pass verification for the happy path.
    function test_verify_acceptsCommittedFeeShield() public {
        bytes32 ap =
            YieldAdaptParams.encode(NPK, _bundle(0), SHIELD_KEY, FEE_NPK, _bundle(100), FEE_SHIELD_KEY, FEE_AMOUNT);
        assertTrue(
            YieldAdaptParams.verify(ap, NPK, _bundle(0), SHIELD_KEY, FEE_NPK, _bundle(100), FEE_SHIELD_KEY, FEE_AMOUNT)
        );
    }

    /// @dev WHY: the core relayer-immutability property — a submitter that redirects the fee to a
    ///      DIFFERENT 0zk destination (fee npk) than the user committed to must fail verification.
    function test_verify_rejectsRedirectedFeeNpk() public {
        bytes32 ap =
            YieldAdaptParams.encode(NPK, _bundle(0), SHIELD_KEY, FEE_NPK, _bundle(100), FEE_SHIELD_KEY, FEE_AMOUNT);
        bytes32 attackerNpk = bytes32(uint256(0xBAD));
        assertFalse(
            YieldAdaptParams.verify(
                ap, NPK, _bundle(0), SHIELD_KEY, attackerNpk, _bundle(100), FEE_SHIELD_KEY, FEE_AMOUNT
            )
        );
    }

    /// @dev WHY: a submitter that inflates the fee amount beyond the user's commitment must fail.
    function test_verify_rejectsInflatedFee() public {
        bytes32 ap =
            YieldAdaptParams.encode(NPK, _bundle(0), SHIELD_KEY, FEE_NPK, _bundle(100), FEE_SHIELD_KEY, FEE_AMOUNT);
        assertFalse(
            YieldAdaptParams.verify(
                ap, NPK, _bundle(0), SHIELD_KEY, FEE_NPK, _bundle(100), FEE_SHIELD_KEY, FEE_AMOUNT * 2
            )
        );
    }

    /// @dev WHY: fuzz the immutability — ANY deviation in the fee npk or amount from the commitment
    ///      must fail verification.
    function testFuzz_verify_rejectsAnyFeeDeviation(
        bytes32 rightFeeNpk,
        uint256 rightAmount,
        bytes32 wrongFeeNpk,
        uint256 wrongAmount
    ) public {
        vm.assume(rightFeeNpk != wrongFeeNpk || rightAmount != wrongAmount);
        bytes32 ap =
            YieldAdaptParams.encode(NPK, _bundle(0), SHIELD_KEY, rightFeeNpk, _bundle(100), FEE_SHIELD_KEY, rightAmount);
        assertFalse(
            YieldAdaptParams.verify(
                ap, NPK, _bundle(0), SHIELD_KEY, wrongFeeNpk, _bundle(100), FEE_SHIELD_KEY, wrongAmount
            )
        );
    }

    /// @dev WHY: the deposit (3-arg, no fee) and withdraw (7-arg, fee-bound) schemes must produce
    ///      DIFFERENT commitments, so a deposit proof cannot be replayed as a zero-fee withdraw.
    function test_encode_depositAndWithdrawSchemesDiffer() public {
        bytes32 deposit = YieldAdaptParams.encode(NPK, _bundle(0), SHIELD_KEY);
        bytes32 withdrawZeroFee =
            YieldAdaptParams.encode(NPK, _bundle(0), SHIELD_KEY, bytes32(0), _bundle(0), bytes32(0), 0);
        assertTrue(deposit != withdrawZeroFee, "deposit and withdraw adaptParams schemes must differ");
    }
}

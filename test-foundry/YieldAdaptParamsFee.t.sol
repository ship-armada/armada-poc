// ABOUTME: Tests YieldAdaptParams fee binding — the withdraw broadcaster fee (recipient + amount) is
// ABOUTME: committed into adaptParams so a relayer cannot redirect or inflate it (issue #312).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/YieldAdaptParams.sol";

contract YieldAdaptParamsFeeTest is Test {
    bytes32 constant NPK = bytes32(uint256(0x1234));
    bytes32 constant SHIELD_KEY = bytes32(uint256(0x5678));

    function _bundle() internal pure returns (bytes32[3] memory b) {
        b[0] = bytes32(uint256(1));
        b[1] = bytes32(uint256(2));
        b[2] = bytes32(uint256(3));
    }

    /// @dev WHY: redeemAndShield verifies (feeRecipient, feeAmount) against adaptParams, so the exact
    ///      committed values must pass verification for the happy path to work at all.
    function test_verify_acceptsCommittedFee() public {
        address feeRecipient = address(0xBEEF);
        uint256 feeAmount = 1_000_000;
        bytes32 ap = YieldAdaptParams.encode(NPK, _bundle(), SHIELD_KEY, feeRecipient, feeAmount);
        assertTrue(YieldAdaptParams.verify(ap, NPK, _bundle(), SHIELD_KEY, feeRecipient, feeAmount));
    }

    /// @dev WHY: the core relayer-immutability property — a submitter that redirects the fee to a
    ///      different recipient than the user committed to must fail verification (adapter reverts).
    function test_verify_rejectsRedirectedFee() public {
        bytes32 ap = YieldAdaptParams.encode(NPK, _bundle(), SHIELD_KEY, address(0xBEEF), 1_000_000);
        assertFalse(YieldAdaptParams.verify(ap, NPK, _bundle(), SHIELD_KEY, address(0xBAD), 1_000_000));
    }

    /// @dev WHY: a submitter that inflates the fee amount beyond the user's commitment must fail.
    function test_verify_rejectsInflatedFee() public {
        bytes32 ap = YieldAdaptParams.encode(NPK, _bundle(), SHIELD_KEY, address(0xBEEF), 1_000_000);
        assertFalse(YieldAdaptParams.verify(ap, NPK, _bundle(), SHIELD_KEY, address(0xBEEF), 2_000_000));
    }

    /// @dev WHY: fuzz the immutability — ANY deviation in recipient or amount from the commitment
    ///      must fail verification.
    function testFuzz_verify_rejectsAnyFeeDeviation(
        address rightRecipient,
        uint256 rightAmount,
        address wrongRecipient,
        uint256 wrongAmount
    ) public {
        vm.assume(rightRecipient != wrongRecipient || rightAmount != wrongAmount);
        bytes32 ap = YieldAdaptParams.encode(NPK, _bundle(), SHIELD_KEY, rightRecipient, rightAmount);
        assertFalse(YieldAdaptParams.verify(ap, NPK, _bundle(), SHIELD_KEY, wrongRecipient, wrongAmount));
    }

    /// @dev WHY: the deposit (3-arg, no fee) and withdraw (5-arg, fee-bound) schemes must produce
    ///      DIFFERENT commitments, so a deposit proof cannot be replayed as a zero-fee withdraw.
    function test_encode_depositAndWithdrawSchemesDiffer() public {
        bytes32 deposit = YieldAdaptParams.encode(NPK, _bundle(), SHIELD_KEY);
        bytes32 withdrawZeroFee = YieldAdaptParams.encode(NPK, _bundle(), SHIELD_KEY, address(0), 0);
        assertTrue(deposit != withdrawZeroFee, "deposit and withdraw adaptParams schemes must differ");
    }
}

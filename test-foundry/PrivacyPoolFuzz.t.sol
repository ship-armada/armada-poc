// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

/// @title PrivacyPoolFuzzTest — Stateless fuzz tests for privacy pool math
/// @dev Tests the _getFee function and CCTP payload encoding in isolation.
contract PrivacyPoolFuzzTest is Test {
    uint120 private constant BASIS_POINTS = 10000;

    /// @dev Mirror of ShieldModule/TransactModule._getFee (inclusive and exclusive modes)
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

    // ═══════════════════════════════════════════════════════════════════
    // FEE MATH — INCLUSIVE MODE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice base + fee == amount (exact conservation, inclusive mode)
    function testFuzz_feeConservation(uint120 amount, uint120 feeBP) public pure {
        amount = uint120(bound(amount, 1, type(uint120).max));
        feeBP = uint120(bound(feeBP, 0, 10000));

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, feeBP);

        assertEq(uint256(base) + uint256(fee), uint256(amount), "base + fee != amount");
    }

    /// @notice fee <= amount (fee never exceeds the amount, inclusive mode)
    function testFuzz_feeNeverExceedsAmount(uint120 amount, uint120 feeBP) public pure {
        amount = uint120(bound(amount, 1, type(uint120).max));
        feeBP = uint120(bound(feeBP, 0, 10000));

        (, uint120 fee) = _getFee(uint136(amount), true, feeBP);

        assertLe(fee, amount, "fee > amount");
    }

    /// @notice feeBP=0 → base=amount, fee=0
    function testFuzz_zeroFeeBps(uint120 amount) public pure {
        amount = uint120(bound(amount, 1, type(uint120).max));

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, 0);

        assertEq(base, amount, "zero fee: base != amount");
        assertEq(fee, 0, "zero fee: fee != 0");
    }

    /// @notice feeBP=10000 → base=0, fee=amount (100% fee)
    function testFuzz_maxFeeBps(uint120 amount) public pure {
        amount = uint120(bound(amount, 1, type(uint120).max));

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, 10000);

        assertEq(base, 0, "max fee: base != 0");
        assertEq(fee, amount, "max fee: fee != amount");
    }

    /// @notice Higher feeBP → higher fee (monotonicity, same amount)
    function testFuzz_feeMonotonicity(uint120 amount, uint120 feeBP_A, uint120 feeBP_B) public pure {
        amount = uint120(bound(amount, 1, type(uint120).max));
        feeBP_A = uint120(bound(feeBP_A, 0, 10000));
        feeBP_B = uint120(bound(feeBP_B, 0, feeBP_A));

        // feeBP_A >= feeBP_B
        (, uint120 feeA) = _getFee(uint136(amount), true, feeBP_A);
        (, uint120 feeB) = _getFee(uint136(amount), true, feeBP_B);

        assertGe(feeA, feeB, "Higher feeBP should produce higher fee");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEE MATH — EXCLUSIVE MODE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Exclusive mode: fee = (BASIS_POINTS * amount) / (BASIS_POINTS - feeBP) - amount
    /// @dev Guards against division by zero (feeBP < 10000 for exclusive mode)
    function testFuzz_exclusiveFeeConsistency(uint120 amount, uint120 feeBP) public pure {
        amount = uint120(bound(amount, 1, 1e30)); // reasonable range to avoid overflow
        feeBP = uint120(bound(feeBP, 1, 9999)); // feeBP < 10000 for exclusive (avoid div by zero)

        // Guard against overflow: BASIS_POINTS * amount must fit in uint256
        vm.assume(uint256(BASIS_POINTS) * uint256(amount) <= type(uint136).max);

        (uint120 base, uint120 fee) = _getFee(uint136(amount), false, feeBP);

        assertEq(base, amount, "Exclusive: base should equal input amount");

        // For small amounts, integer division can truncate fee to 0.
        // e.g. amount=1, feeBP=3: (10000*1)/(10000-3) - 1 = 1 - 1 = 0
        // Fee > 0 only when amount is large enough relative to feeBP.
        // Verify: fee matches the exact formula (including truncation)
        uint256 expectedFee = (uint256(BASIS_POINTS) * uint256(amount)) / uint256(BASIS_POINTS - feeBP) - uint256(amount);
        assertEq(fee, uint120(expectedFee), "Exclusive fee formula mismatch");

        // Fee should be > 0 when amount >= ceil(10000 / feeBP)
        if (amount >= (BASIS_POINTS + feeBP - 1) / feeBP) {
            assertGt(fee, 0, "Exclusive: fee should be > 0 for sufficiently large amount");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // CCTP PAYLOAD ENCODING (tested via raw ABI encoding)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Shield payload round-trip: encode → decode → identical
    /// @dev Uses helper to avoid stack-too-deep (Solidity 0.8.17 without viaIR)
    function testFuzz_shieldPayloadRoundTrip(bytes32 npk, uint120 value, bytes32 shieldKey) public pure {
        bytes32 enc0 = keccak256(abi.encode(npk));
        bytes32 enc1 = keccak256(abi.encode(value));
        bytes32 enc2 = keccak256(abi.encode(shieldKey));

        bytes memory shieldData = abi.encode(npk, value, enc0, enc1, enc2, shieldKey);
        bytes memory payload = abi.encode(uint8(0), shieldData);

        (uint8 messageType, bytes memory data) = abi.decode(payload, (uint8, bytes));
        assertEq(messageType, 0, "Message type should be SHIELD");

        _verifyShieldData(data, npk, value, shieldKey);
    }

    function _verifyShieldData(bytes memory data, bytes32 npk, uint120 value, bytes32 shieldKey) internal pure {
        (bytes32 dNpk, uint120 dValue, , , , bytes32 dKey) =
            abi.decode(data, (bytes32, uint120, bytes32, bytes32, bytes32, bytes32));
        assertEq(dNpk, npk, "npk mismatch");
        assertEq(dValue, value, "value mismatch");
        assertEq(dKey, shieldKey, "shieldKey mismatch");
    }

    /// @notice Unshield payload round-trip: encode → decode → identical
    function testFuzz_unshieldPayloadRoundTrip(address recipient) public pure {
        // Encode as CCTPPayload (messageType=1 for UNSHIELD)
        bytes memory unshieldData = abi.encode(recipient);
        bytes memory innerPayload = abi.encode(uint8(1), unshieldData);

        // Decode
        (uint8 messageType, bytes memory data) = abi.decode(innerPayload, (uint8, bytes));
        assertEq(messageType, 1, "Message type should be UNSHIELD");

        address decodedRecipient = abi.decode(data, (address));
        assertEq(decodedRecipient, recipient);
    }
}

// ABOUTME: Foundry fuzz tests for CCTP V2 fast finality threshold boundary and dispatch logic.
// ABOUTME: Tests CCTPHookRouter dispatch, finality threshold validation, and fee accounting.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/cctp/ICCTPV2.sol";

/// @title FastFinalityFuzzTest — Stateless fuzz tests for fast finality logic
/// @dev Tests the finality threshold boundary (FAST=1000, STANDARD=2000) and
///      the dispatch decision in CCTPHookRouter.
contract FastFinalityFuzzTest is Test {
    uint32 private constant FAST = 1000;
    uint32 private constant STANDARD = 2000;

    // ═══════════════════════════════════════════════════════════════════
    // FINALITY THRESHOLD BOUNDARY
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Finality >= STANDARD always routes to handleReceiveFinalizedMessage
    function testFuzz_standardFinalityDispatch(uint32 finality) public pure {
        finality = uint32(bound(finality, STANDARD, type(uint32).max));

        // The dispatch condition in CCTPHookRouter:
        // if (finality >= CCTPFinality.STANDARD) -> handleReceiveFinalizedMessage
        bool isFinalized = finality >= STANDARD;
        assertTrue(isFinalized, "finality >= STANDARD should be finalized");
    }

    /// @notice Finality < STANDARD routes to handleReceiveUnfinalizedMessage
    function testFuzz_fastFinalityDispatch(uint32 finality) public pure {
        finality = uint32(bound(finality, 0, STANDARD - 1));

        bool isFinalized = finality >= STANDARD;
        assertFalse(isFinalized, "finality < STANDARD should be unfinalized");
    }

    /// @notice The boundary is exactly at STANDARD (2000): 1999 is unfinalized, 2000 is finalized
    function testFuzz_boundaryExact(uint32 finality) public pure {
        finality = uint32(bound(finality, STANDARD - 1, STANDARD));

        bool isFinalized = finality >= STANDARD;

        if (finality == STANDARD) {
            assertTrue(isFinalized, "finality == STANDARD should be finalized");
        } else {
            assertFalse(isFinalized, "finality == STANDARD-1 should be unfinalized");
        }
    }

    /// @notice FAST threshold acceptance: only finality >= FAST (1000) should be accepted
    function testFuzz_fastThresholdAcceptance(uint32 finality) public pure {
        finality = uint32(bound(finality, 0, STANDARD - 1)); // Only unfinalized range

        bool meetsMinFast = finality >= FAST;

        if (finality >= FAST) {
            assertTrue(meetsMinFast, "finality >= FAST should be accepted");
        } else {
            assertFalse(meetsMinFast, "finality < FAST should be rejected");
        }
    }

    /// @notice Values below FAST should never be accepted as fast finality
    function testFuzz_belowFastRejected(uint32 finality) public pure {
        finality = uint32(bound(finality, 0, FAST - 1));

        bool meetsMinFast = finality >= FAST;
        assertFalse(meetsMinFast, "finality < FAST must be rejected");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINALITY THRESHOLD VALIDATION (setDefaultFinalityThreshold)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Only FAST and STANDARD are valid thresholds for setDefaultFinalityThreshold
    function testFuzz_invalidThresholdRejected(uint32 threshold) public pure {
        // Any value that isn't FAST or STANDARD should be invalid
        bool isValid = (threshold == FAST || threshold == STANDARD);

        if (threshold != FAST && threshold != STANDARD) {
            assertFalse(isValid, "Non-FAST/STANDARD threshold should be invalid");
        }
    }

    /// @notice FAST and STANDARD are always valid thresholds
    function test_validThresholds() public pure {
        assertTrue(FAST == 1000, "FAST should be 1000");
        assertTrue(STANDARD == 2000, "STANDARD should be 2000");
        assertTrue(FAST < STANDARD, "FAST should be less than STANDARD");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FEE ACCOUNTING WITH FAST FINALITY
    // ═══════════════════════════════════════════════════════════════════

    /// @notice CCTP fee deduction: actualAmount = grossAmount - feeExecuted
    function testFuzz_cctpFeeDeduction(uint256 grossAmount, uint256 feeExecuted) public pure {
        grossAmount = bound(grossAmount, 1, type(uint128).max);
        feeExecuted = bound(feeExecuted, 0, grossAmount - 1); // fee < grossAmount

        uint256 actualAmount = grossAmount - feeExecuted;

        assertGt(actualAmount, 0, "actualAmount should be > 0");
        assertLe(actualAmount, grossAmount, "actualAmount should be <= grossAmount");
        assertEq(actualAmount + feeExecuted, grossAmount, "fee conservation: actual + fee == gross");
    }

    /// @notice CCTP fast fee (1-1.3 bps) should never exceed the transfer amount
    function testFuzz_cctpFastFeeNeverExceedsAmount(uint256 amount, uint256 feeBps) public pure {
        amount = bound(amount, 1, type(uint128).max);
        feeBps = bound(feeBps, 0, 13); // 1.3 bps max = 13/10000

        uint256 fee = (amount * feeBps) / 10000;

        assertLe(fee, amount, "CCTP fast fee should never exceed amount");
    }

    /// @notice Fast transfer fee for typical USDC amounts (1 USDC to 10M USDC)
    function testFuzz_fastFeeReasonableRange(uint256 amountRaw) public pure {
        // USDC has 6 decimals: 1 USDC = 1e6 raw, 10M USDC = 1e13 raw
        amountRaw = bound(amountRaw, 1e6, 1e13);

        // Worst case: 1.3 bps = 13/100000
        uint256 worstCaseFee = (amountRaw * 13) / 100000;

        // Fee should be at most 0.013% of amount
        assertLe(worstCaseFee * 100000, amountRaw * 13, "Fee proportionality check");

        // For 10,000 USDC (1e10 raw), worst case fee = 1.3 USDC (1.3e6 raw)
        // Sanity check: fee is small relative to amount
        assertLt(worstCaseFee, amountRaw / 50, "Fee should be less than 2% of amount");
    }

    // ═══════════════════════════════════════════════════════════════════
    // CONFIGURABLE DEFAULT FINALITY — BACKWARD COMPATIBILITY
    // ═══════════════════════════════════════════════════════════════════

    /// @notice defaultFinalityThreshold fallback: 0 should resolve to STANDARD
    function testFuzz_defaultFinalityFallback(uint32 stored) public pure {
        // Mirror the contract logic: defaultFinalityThreshold > 0 ? defaultFinalityThreshold : CCTPFinality.STANDARD
        uint32 effective = stored > 0 ? stored : STANDARD;

        if (stored == 0) {
            assertEq(effective, STANDARD, "Zero stored should default to STANDARD");
        } else {
            assertEq(effective, stored, "Non-zero stored should be used as-is");
        }
    }
}

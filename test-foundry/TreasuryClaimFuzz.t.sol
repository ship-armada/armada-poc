// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title TreasuryClaimFuzz — Fuzz tests for claim revocability and expiry (#23)
/// @dev Tests the claim lifecycle: create, exercise, revoke, expire.
contract TreasuryClaimFuzzTest is Test {
    ArmadaTreasuryGov public treasury;
    MockUSDCV2 public usdc;

    address owner = address(this);
    address guardian = address(0xBEEF);
    address beneficiary = address(0xCAFE);
    address nonOwner = address(0xDEAD);

    uint256 constant TREASURY_BALANCE = 10_000_000e6; // 10M USDC

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        treasury = new ArmadaTreasuryGov(owner, guardian, 14 days);
        usdc.mint(address(treasury), TREASURY_BALANCE);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: exercised + revoked amounts never exceed original claim
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_exerciseThenRevoke_noOverflow(
        uint256 amount,
        uint256 exerciseAmount
    ) public {
        amount = bound(amount, 1, TREASURY_BALANCE);
        exerciseAmount = bound(exerciseAmount, 0, amount);

        treasury.createClaim(address(usdc), beneficiary, amount, 0);

        if (exerciseAmount > 0) {
            vm.prank(beneficiary);
            treasury.exerciseClaim(1, exerciseAmount);
        }

        // Remaining should be exact
        uint256 remaining = treasury.getClaimRemaining(1);
        assertEq(remaining, amount - exerciseAmount, "remaining mismatch before revoke");

        // Revoke
        treasury.revokeClaim(1);

        // After revoke, remaining is 0
        assertEq(treasury.getClaimRemaining(1), 0, "remaining should be 0 after revoke");

        // Cannot exercise after revoke
        vm.prank(beneficiary);
        vm.expectRevert("ArmadaTreasuryGov: claim revoked");
        treasury.exerciseClaim(1, 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: claim with expiry works before and fails after
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_expiryEnforced(
        uint256 amount,
        uint256 expiryOffset,
        uint256 exerciseAmount
    ) public {
        amount = bound(amount, 1, TREASURY_BALANCE);
        expiryOffset = bound(expiryOffset, 1 hours, 365 days);
        exerciseAmount = bound(exerciseAmount, 1, amount);

        uint256 expiresAt = block.timestamp + expiryOffset;
        treasury.createClaim(address(usdc), beneficiary, amount, expiresAt);

        // Exercise before expiry succeeds
        vm.prank(beneficiary);
        treasury.exerciseClaim(1, exerciseAmount);

        // Warp past expiry
        vm.warp(expiresAt + 1);

        // Remaining shows 0
        assertEq(treasury.getClaimRemaining(1), 0, "remaining should be 0 after expiry");

        // Exercise after expiry fails
        uint256 leftover = amount - exerciseAmount;
        if (leftover > 0) {
            vm.prank(beneficiary);
            vm.expectRevert("ArmadaTreasuryGov: claim expired");
            treasury.exerciseClaim(1, leftover);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: only owner can revoke
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_onlyOwnerCanRevoke(address caller) public {
        vm.assume(caller != owner);

        treasury.createClaim(address(usdc), beneficiary, 1000e6, 0);

        vm.prank(caller);
        vm.expectRevert("ArmadaTreasuryGov: not owner");
        treasury.revokeClaim(1);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: multiple claims — revoke one, others unaffected
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_revokeOneClaimLeavesOthersIntact(
        uint256 amount1,
        uint256 amount2,
        uint256 revokeIdx
    ) public {
        amount1 = bound(amount1, 1, TREASURY_BALANCE / 2);
        amount2 = bound(amount2, 1, TREASURY_BALANCE / 2);
        revokeIdx = bound(revokeIdx, 1, 2);

        treasury.createClaim(address(usdc), beneficiary, amount1, 0); // claim 1
        treasury.createClaim(address(usdc), beneficiary, amount2, 0); // claim 2

        // Revoke one
        treasury.revokeClaim(revokeIdx);

        // Revoked claim has 0 remaining
        assertEq(treasury.getClaimRemaining(revokeIdx), 0);

        // Other claim still has full remaining
        uint256 otherIdx = revokeIdx == 1 ? 2 : 1;
        uint256 otherAmount = revokeIdx == 1 ? amount2 : amount1;
        assertEq(treasury.getClaimRemaining(otherIdx), otherAmount);

        // Can still exercise the non-revoked claim
        vm.prank(beneficiary);
        treasury.exerciseClaim(otherIdx, otherAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: expiresAt=0 means never expires
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_zeroExpiryNeverExpires(uint256 timeJump) public {
        timeJump = bound(timeJump, 1, 100 * 365 days);

        treasury.createClaim(address(usdc), beneficiary, 1000e6, 0);

        vm.warp(block.timestamp + timeJump);

        // Still exercisable
        assertEq(treasury.getClaimRemaining(1), 1000e6);
        vm.prank(beneficiary);
        treasury.exerciseClaim(1, 1000e6);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: cannot create claim with past expiry
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_rejectPastExpiry(uint256 pastOffset) public {
        // Warp to a realistic timestamp so subtraction doesn't produce 0 (the "never expires" sentinel)
        vm.warp(1_700_000_000);
        pastOffset = bound(pastOffset, 1, block.timestamp - 1);
        uint256 pastExpiry = block.timestamp - pastOffset;
        // pastExpiry is >= 1 (not the 0 sentinel) and < block.timestamp

        vm.expectRevert("ArmadaTreasuryGov: expires in past");
        treasury.createClaim(address(usdc), beneficiary, 1000e6, pastExpiry);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Invariant: USDC balance conservation across exercise + revoke
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_usdcConservation(
        uint256 amount,
        uint256 exerciseAmount
    ) public {
        amount = bound(amount, 1, TREASURY_BALANCE);
        exerciseAmount = bound(exerciseAmount, 0, amount);

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        uint256 beneficiaryBefore = usdc.balanceOf(beneficiary);

        treasury.createClaim(address(usdc), beneficiary, amount, 0);

        if (exerciseAmount > 0) {
            vm.prank(beneficiary);
            treasury.exerciseClaim(1, exerciseAmount);
        }

        // Revoke remaining
        treasury.revokeClaim(1);

        // Treasury lost exactly exerciseAmount, beneficiary gained exactly exerciseAmount
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore - exerciseAmount);
        assertEq(usdc.balanceOf(beneficiary), beneficiaryBefore + exerciseAmount);
    }
}

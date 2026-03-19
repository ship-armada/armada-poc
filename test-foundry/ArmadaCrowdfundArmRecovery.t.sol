// ABOUTME: Tests for ARM token recovery after crowdfund cancellation (issue #69).
// ABOUTME: Verifies withdrawUnallocatedArm() works in Canceled phase and edge cases.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract ArmadaCrowdfundArmRecoveryTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant THIRTY_DAYS = 30 days;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            treasury,
            admin
        );

        // Fund ARM tokens and verify pre-load
        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // Start window to set windowEnd
        address[] memory seeds = new address[](1);
        seeds[0] = address(0xA);
        crowdfund.addSeeds(seeds);
        crowdfund.startWindow();
    }

    /// @notice Helper: advance past commitment period and cancel via permissionlessCancel
    function _cancelViaTooFewCommitments() internal {
        // Warp past window end + grace period so permissionlessCancel() can be called.
        // finalize() reverts when totalCommitted < MIN_SALE; the cancel path
        // is handled by permissionlessCancel() or claimRefund() directly.
        vm.warp(crowdfund.windowEnd() + THIRTY_DAYS + 1);
        crowdfund.permissionlessCancel();
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Canceled));
    }

    // ============ Core fix: ARM recovery in Canceled phase ============

    /// @notice withdrawUnallocatedArm() succeeds in Canceled phase and returns full ARM balance
    function test_withdrawUnallocatedArm_canceled_returnsFullBalance() public {
        _cancelViaTooFewCommitments();

        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);

        assertEq(treasuryAfter - treasuryBefore, ARM_FUNDING, "treasury should receive all ARM");
        assertEq(armToken.balanceOf(address(crowdfund)), 0, "crowdfund should have zero ARM");
        assertTrue(crowdfund.unallocatedArmWithdrawn(), "flag should be set");
    }

    /// @notice Double-call reverts even in Canceled phase
    function test_withdrawUnallocatedArm_canceled_doubleCallReverts() public {
        _cancelViaTooFewCommitments();

        crowdfund.withdrawUnallocatedArm();

        vm.expectRevert("ArmadaCrowdfund: already withdrawn");
        crowdfund.withdrawUnallocatedArm();
    }

    /// @notice Non-admin cannot call withdrawUnallocatedArm in Canceled phase
    function test_withdrawUnallocatedArm_canceled_nonAdminReverts() public {
        _cancelViaTooFewCommitments();

        vm.prank(address(0xBEEF));
        vm.expectRevert("ArmadaCrowdfund: not admin");
        crowdfund.withdrawUnallocatedArm();
    }

    // ============ Phase guards: still reverts in pre-finalization phases ============

    /// @notice Reverts in Setup phase
    function test_withdrawUnallocatedArm_setupPhase_reverts() public {
        // Deploy a fresh crowdfund still in Setup phase
        ArmadaCrowdfund fresh = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            treasury,
            admin
        );

        vm.expectRevert("ArmadaCrowdfund: not finalized or canceled");
        fresh.withdrawUnallocatedArm();
    }

    /// @notice Reverts in Active phase
    function test_withdrawUnallocatedArm_activePhase_reverts() public {
        // setUp already moved crowdfund to Active phase
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Active));

        vm.expectRevert("ArmadaCrowdfund: not finalized or canceled");
        crowdfund.withdrawUnallocatedArm();
    }

    /// @notice Reverts in Active phase (near window end)
    function test_withdrawUnallocatedArm_activePhaseNearEnd_reverts() public {
        // Warp to near the end of the active window — still Active phase
        vm.warp(crowdfund.windowEnd() - 1);
        vm.expectRevert("ArmadaCrowdfund: not finalized or canceled");
        crowdfund.withdrawUnallocatedArm();
    }

    // ============ Fuzz: ARM recovery amount is always full balance when canceled ============

    /// @notice Fuzz: any ARM funding amount (>= MAX_SALE) is fully recoverable after cancellation
    function testFuzz_withdrawUnallocatedArm_canceled_fullRecovery(uint256 funding) public {
        // Bound to range from MAX_SALE to 10M tokens (loadArm requires >= MAX_SALE)
        funding = bound(funding, 1_800_000 * 1e18, 10_000_000 * 1e18);

        // Deploy fresh crowdfund with fuzzed funding
        ArmadaCrowdfund fuzzCrowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            treasury,
            admin
        );
        armToken.transfer(address(fuzzCrowdfund), funding);
        fuzzCrowdfund.loadArm();

        address[] memory seeds = new address[](1);
        seeds[0] = address(0xA);
        fuzzCrowdfund.addSeeds(seeds);
        fuzzCrowdfund.startWindow();

        // Cancel via permissionlessCancel (finalize reverts when below MIN_SALE)
        vm.warp(fuzzCrowdfund.windowEnd() + THIRTY_DAYS + 1);
        fuzzCrowdfund.permissionlessCancel();

        // Recover
        uint256 treasuryBefore = armToken.balanceOf(treasury);
        fuzzCrowdfund.withdrawUnallocatedArm();
        uint256 recovered = armToken.balanceOf(treasury) - treasuryBefore;

        assertEq(recovered, funding, "should recover exact funding amount");
    }
}

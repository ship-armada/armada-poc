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

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            treasury,
            admin,
            admin   // securityCouncil
        );

        // Whitelist admin and crowdfund so token transfers work
        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        // Fund ARM tokens and verify pre-load
        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // Start window to set windowEnd
        address[] memory seeds = new address[](1);
        seeds[0] = address(0xA);
        crowdfund.addSeeds(seeds);
        crowdfund.startWindow();
    }

    /// @notice Helper: cancel via security council
    function _cancelViaSecurityCouncil() internal {
        // Security council (admin in test setup) cancels the crowdfund.
        // finalize() reverts when totalCommitted < MIN_SALE; the cancel path
        // is handled by security council cancel() or claimRefund() directly.
        crowdfund.cancel();
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Canceled));
    }

    // ============ Core fix: ARM recovery in Canceled phase ============

    /// @notice withdrawUnallocatedArm() succeeds in Canceled phase and returns full ARM balance
    function test_withdrawUnallocatedArm_canceled_returnsFullBalance() public {
        _cancelViaSecurityCouncil();

        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);

        assertEq(treasuryAfter - treasuryBefore, ARM_FUNDING, "treasury should receive all ARM");
        assertEq(armToken.balanceOf(address(crowdfund)), 0, "crowdfund should have zero ARM");
    }

    /// @notice Double-call reverts when nothing left to sweep
    function test_withdrawUnallocatedArm_canceled_doubleCallReverts() public {
        _cancelViaSecurityCouncil();

        crowdfund.withdrawUnallocatedArm();

        vm.expectRevert("ArmadaCrowdfund: nothing to sweep");
        crowdfund.withdrawUnallocatedArm();
    }

    /// @notice Anyone can call withdrawUnallocatedArm (permissionless)
    function test_withdrawUnallocatedArm_canceled_permissionless() public {
        _cancelViaSecurityCouncil();

        vm.prank(address(0xBEEF));
        crowdfund.withdrawUnallocatedArm();
        assertEq(armToken.balanceOf(address(crowdfund)), 0, "all ARM swept");
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
            admin,
            admin   // securityCouncil
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
            admin,
            admin   // securityCouncil
        );
        armToken.addToWhitelist(address(fuzzCrowdfund));
        armToken.transfer(address(fuzzCrowdfund), funding);
        fuzzCrowdfund.loadArm();

        address[] memory seeds = new address[](1);
        seeds[0] = address(0xA);
        fuzzCrowdfund.addSeeds(seeds);
        fuzzCrowdfund.startWindow();

        // Cancel via security council (admin == securityCouncil in test setup)
        fuzzCrowdfund.cancel();

        // Recover
        uint256 treasuryBefore = armToken.balanceOf(treasury);
        fuzzCrowdfund.withdrawUnallocatedArm();
        uint256 recovered = armToken.balanceOf(treasury) - treasuryBefore;

        assertEq(recovered, funding, "should recover exact funding amount");
    }
}

// ABOUTME: Tests that direct token donations (bypassing commit/loadArm) don't corrupt accounting.
// ABOUTME: Verifies totalCommitted, allocation math, and ARM sweep are unaffected by donations.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract CrowdfundDonationTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;

    address[] public seeds;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            treasury,
            admin,
            admin,
            block.timestamp
        );

        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // 80 seeds — enough to reach MIN_SALE threshold for finalization tests
        for (uint256 i = 0; i < 80; i++) {
            seeds.push(address(uint160(0xA000 + i)));
        }
        crowdfund.addSeeds(seeds);
    }

    /// @notice Helper: each seed commits full $15K at hop-0
    function _allSeedsCommitFull() internal {
        for (uint256 i = 0; i < seeds.length; i++) {
            uint256 amount = 15_000 * 1e6;
            usdc.mint(seeds[i], amount);
            vm.startPrank(seeds[i]);
            usdc.approve(address(crowdfund), amount);
            crowdfund.commit(0, amount);
            vm.stopPrank();
        }
    }

    // ============ Donation Attack Tests ============

    /// @notice Direct USDC transfer to contract does not change totalCommitted
    function test_directUsdcTransfer_doesNotChangeCommitAccounting() public {
        // One seed commits normally
        uint256 commitAmt = 15_000 * 1e6;
        usdc.mint(seeds[0], commitAmt);
        vm.startPrank(seeds[0]);
        usdc.approve(address(crowdfund), commitAmt);
        crowdfund.commit(0, commitAmt);
        vm.stopPrank();

        uint256 totalBefore = crowdfund.totalCommitted();
        assertEq(totalBefore, commitAmt);

        // Donate USDC directly (bypassing commit)
        uint256 donationAmt = 100_000 * 1e6;
        usdc.mint(address(crowdfund), donationAmt);

        // totalCommitted must be unaffected
        assertEq(crowdfund.totalCommitted(), totalBefore, "totalCommitted must not change from donation");
        // But the raw balance increased
        assertEq(
            usdc.balanceOf(address(crowdfund)),
            commitAmt + donationAmt,
            "USDC balance should reflect both commit and donation"
        );
    }

    /// @notice Direct ARM transfer after finalization does not change allocation math
    function test_directArmTransfer_doesNotAffectAllocationMath() public {
        // Need a successful (non-refundMode) finalization for allocations to exist.
        // Use 53 seeds at hop-0 + 53 hop-1 participants to exceed MIN_SALE.
        for (uint256 i = 0; i < 53; i++) {
            uint256 amount = 15_000 * 1e6;
            usdc.mint(seeds[i], amount);
            vm.startPrank(seeds[i]);
            usdc.approve(address(crowdfund), amount);
            crowdfund.commit(0, amount);
            vm.stopPrank();
        }

        // Create hop-1 participants via seed invites
        address[] memory hop1Addrs = new address[](53);
        for (uint256 i = 0; i < 53; i++) {
            hop1Addrs[i] = address(uint160(0xB000 + i));
            vm.prank(seeds[i]);
            crowdfund.invite(hop1Addrs[i], 0);
        }

        for (uint256 i = 0; i < 53; i++) {
            uint256 amount = 4_000 * 1e6;
            usdc.mint(hop1Addrs[i], amount);
            vm.startPrank(hop1Addrs[i]);
            usdc.approve(address(crowdfund), amount);
            crowdfund.commit(1, amount);
            vm.stopPrank();
        }

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode());

        // Record allocations before ARM donation
        uint256 totalAllocBefore = crowdfund.totalAllocatedArm();
        (uint256 seed0AllocArm, ) = crowdfund.computeAllocation(seeds[0]);
        assertTrue(totalAllocBefore > 0, "Must have allocations");

        // Donate extra ARM directly to the contract
        uint256 extraArm = 100_000 * 1e18;
        armToken.transfer(address(crowdfund), extraArm);

        // Allocations must be unchanged
        assertEq(crowdfund.totalAllocatedArm(), totalAllocBefore, "totalAllocatedArm must not change");
        (uint256 seed0AllocArmAfter, ) = crowdfund.computeAllocation(seeds[0]);
        assertEq(seed0AllocArmAfter, seed0AllocArm, "Per-address allocation must not change");
    }

    /// @notice withdrawUnallocatedArm captures donated ARM alongside unallocated ARM
    function test_withdrawUnallocatedArm_capturesDonatedArm() public {
        // Use refundMode scenario: all 80 seeds commit hop-0, refundMode triggers
        _allSeedsCommitFull();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertTrue(crowdfund.refundMode(), "Must be in refund mode");

        // Donate extra ARM directly
        uint256 extraArm = 50_000 * 1e18;
        armToken.transfer(address(crowdfund), extraArm);

        // In refundMode, armStillOwed = 0, so all ARM (funding + donation) is sweepable
        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);

        assertEq(
            treasuryAfter - treasuryBefore,
            ARM_FUNDING + extraArm,
            "Sweep must capture both original funding and donated ARM"
        );
    }

    /// @notice ARM sweep still requires Finalized/Canceled phase even with USDC donation
    function test_donatedUsdc_doesNotEnablePrematureSweep() public {
        // Donate USDC directly while still in Active phase
        usdc.mint(address(crowdfund), 500_000 * 1e6);

        // withdrawUnallocatedArm should still revert — phase is Active
        vm.expectRevert("ArmadaCrowdfund: not finalized or canceled");
        crowdfund.withdrawUnallocatedArm();
    }
}

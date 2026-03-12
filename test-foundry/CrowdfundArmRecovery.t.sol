// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title CrowdfundArmRecovery — Fuzz tests for ARM token recovery after cancellation (H-10)
contract CrowdfundArmRecoveryTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasuryAddr;
    address public participant;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant THIRTY_DAYS = 30 days;

    function setUp() public {
        admin = address(this);
        treasuryAddr = address(0xCAFE);
        participant = address(0xBEEF);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            treasuryAddr
        );

        // Fund ARM
        armToken.transfer(address(crowdfund), ARM_FUNDING);

        // Setup: add seed, start invitations, warp to commitment
        address[] memory seeds = new address[](1);
        seeds[0] = participant;
        crowdfund.addSeeds(seeds);
        crowdfund.startInvitations();

        // Warp past invitation into commitment
        vm.warp(crowdfund.commitmentStart() + 1);

        // Participant commits a small amount (below MIN_SALE)
        usdc.mint(participant, 10_000e6);
        vm.startPrank(participant);
        usdc.approve(address(crowdfund), 10_000e6);
        crowdfund.commit(10_000e6);
        vm.stopPrank();

        // Warp past commitment end and cancel
        vm.warp(crowdfund.commitmentEnd() + 1);
        crowdfund.finalize(); // cancels because below MIN_SALE
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: ARM balance is fully recoverable after cancel
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_fullArmRecoveryAfterCancel(uint256 timeAfterCancel) public {
        timeAfterCancel = bound(timeAfterCancel, 0, 365 days);
        vm.warp(block.timestamp + timeAfterCancel);

        uint256 armInContract = armToken.balanceOf(address(crowdfund));
        uint256 treasuryBefore = armToken.balanceOf(treasuryAddr);

        crowdfund.withdrawArmAfterCancel();

        assertEq(armToken.balanceOf(address(crowdfund)), 0, "contract should have 0 ARM");
        assertEq(
            armToken.balanceOf(treasuryAddr) - treasuryBefore,
            armInContract,
            "treasury should receive all ARM"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // Only admin can recover ARM
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_onlyAdminCanRecoverArm(address caller) public {
        vm.assume(caller != admin);

        vm.prank(caller);
        vm.expectRevert("ArmadaCrowdfund: not admin");
        crowdfund.withdrawArmAfterCancel();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Cannot double-withdraw
    // ═══════════════════════════════════════════════════════════════════

    function test_cannotDoubleWithdraw() public {
        crowdfund.withdrawArmAfterCancel();

        vm.expectRevert("ArmadaCrowdfund: already withdrawn");
        crowdfund.withdrawArmAfterCancel();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ARM recovery + USDC refund don't interfere
    // ═══════════════════════════════════════════════════════════════════

    function test_armRecoveryAndUsdcRefundIndependent() public {
        // Participant refunds USDC
        uint256 participantUsdcBefore = usdc.balanceOf(participant);
        vm.prank(participant);
        crowdfund.refund();
        assertEq(usdc.balanceOf(participant) - participantUsdcBefore, 10_000e6);

        // Admin recovers ARM
        uint256 armInContract = armToken.balanceOf(address(crowdfund));
        crowdfund.withdrawArmAfterCancel();
        assertEq(armToken.balanceOf(address(crowdfund)), 0);
        assertEq(armToken.balanceOf(treasuryAddr), armInContract);
    }

    // ═══════════════════════════════════════════════════════════════════
    // withdrawUnallocatedArm reverts when canceled (wrong function)
    // ═══════════════════════════════════════════════════════════════════

    function test_withdrawUnallocatedArmRevertsWhenCanceled() public {
        vm.expectRevert("ArmadaCrowdfund: not finalized");
        crowdfund.withdrawUnallocatedArm();
    }

    // ═══════════════════════════════════════════════════════════════════
    // withdrawArmAfterCancel reverts when finalized (not canceled)
    // ═══════════════════════════════════════════════════════════════════

    function test_withdrawArmAfterCancelRevertsWhenFinalized() public {
        // Deploy a fresh crowdfund and finalize it successfully
        ArmadaCrowdfund cf2 = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            treasuryAddr
        );
        armToken.transfer(address(cf2), ARM_FUNDING);

        // Need enough participants to reach MIN_SALE ($1M)
        // 68 participants * $15K each = $1.02M
        address[] memory seeds = new address[](68);
        for (uint256 i = 0; i < 68; i++) {
            seeds[i] = address(uint160(0x1000 + i));
        }
        cf2.addSeeds(seeds);
        cf2.startInvitations();

        vm.warp(cf2.commitmentStart() + 1);

        for (uint256 i = 0; i < 68; i++) {
            usdc.mint(seeds[i], 15_000e6);
            vm.startPrank(seeds[i]);
            usdc.approve(address(cf2), 15_000e6);
            cf2.commit(15_000e6);
            vm.stopPrank();
        }

        vm.warp(cf2.commitmentEnd() + 1);
        cf2.finalize();
        assertEq(uint256(cf2.phase()), uint256(Phase.Finalized));

        // withdrawArmAfterCancel should revert
        vm.expectRevert("ArmadaCrowdfund: not canceled");
        cf2.withdrawArmAfterCancel();
    }
}

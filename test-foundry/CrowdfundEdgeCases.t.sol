// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title CrowdfundEdgeCasesTest
/// @notice Tests for scenarios 6.9, 6.10, 6.13 (allocation precision) and
///         permissionlessCancel flow from docs/CROWDFUND_TEST_SCENARIOS.md
contract CrowdfundEdgeCasesTest is Test {
    ArmadaCrowdfund crowdfund;
    MockUSDCV2 usdc;
    ArmadaToken armToken;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address anyone = address(0x9999);

    // We need ~67 seeds at $15K each to reach $1M MIN_SALE
    uint256 constant NUM_SEEDS = 70;
    uint256 constant HOP0_CAP = 15_000 * 1e6;
    uint256 constant MIN_COMMIT = 10 * 1e6;

    address[] seeds;

    function setUp() public {
        usdc = new MockUSDCV2("USDC", "USDC");
        armToken = new ArmadaToken(address(this));

        crowdfund = new ArmadaCrowdfund(
            address(usdc), address(armToken), admin, treasury
        );

        // Fund ARM to crowdfund for claims
        armToken.transfer(address(crowdfund), 2_000_000e18);

        // Create seeds
        for (uint256 i = 0; i < NUM_SEEDS; i++) {
            seeds.push(address(uint160(0x1000 + i)));
        }

        // Add all seeds
        vm.startPrank(admin);
        crowdfund.addSeeds(seeds);
        crowdfund.startInvitations();
        vm.stopPrank();
    }

    /// @notice Helper: advance to commitment window
    function _advanceToCommitment() internal {
        vm.warp(crowdfund.commitmentStart());
    }

    /// @notice Helper: advance past commitment end
    function _advancePastCommitment() internal {
        vm.warp(crowdfund.commitmentEnd() + 1);
    }

    /// @notice Helper: commit USDC for a user
    function _commit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(crowdfund), amount);
        crowdfund.commit(amount);
        vm.stopPrank();
    }

    /// @notice Helper: fill enough seeds to pass MIN_SALE ($1M) for finalization
    function _fillMinimum() internal {
        _advanceToCommitment();
        // Need 67 seeds * $15K = $1.005M > $1M MIN_SALE
        for (uint256 i = 0; i < 67; i++) {
            _commit(seeds[i], HOP0_CAP);
        }
    }

    /// @notice Helper: claim and measure balances via diffs
    function _claimAndMeasure(address user) internal returns (uint256 armReceived, uint256 usdcReceived) {
        uint256 armBefore = armToken.balanceOf(user);
        uint256 usdcBefore = usdc.balanceOf(user);

        vm.prank(user);
        crowdfund.claim();

        armReceived = armToken.balanceOf(user) - armBefore;
        usdcReceived = usdc.balanceOf(user) - usdcBefore;
    }

    // =====================================================================
    // 6.13: _computeAllocation with committed = 0 -> returns (0, 0, 0)
    // =====================================================================

    function test_6_13_zeroCommitmentReturnsZero() public {
        _fillMinimum();
        // seeds[67], seeds[68], seeds[69] have not committed
        _advancePastCommitment();

        vm.prank(admin);
        crowdfund.finalize();

        // seeds[68] has committed 0
        address nonCommitter = seeds[68];
        (uint256 committed,) = crowdfund.getCommitment(nonCommitter);
        assertEq(committed, 0);

        // getAllocation returns (allocation=0, refund=0, claimed=false) for zero commitment
        (uint256 allocation, uint256 refundAmt, bool claimed) = crowdfund.getAllocation(nonCommitter);
        assertEq(allocation, 0);
        assertEq(refundAmt, 0);
        assertFalse(claimed);
    }

    // =====================================================================
    // 6.9: Pro-rata with small committed among large demand
    // =====================================================================

    function test_6_9_dustCommitmentProRata() public {
        _advanceToCommitment();

        // Fill 67 seeds to max ($15K each) — oversubscribes hop-0 reserve
        for (uint256 i = 0; i < 67; i++) {
            _commit(seeds[i], HOP0_CAP);
        }
        // seeds[67] commits minimum $10
        _commit(seeds[67], MIN_COMMIT);

        _advancePastCommitment();

        vm.prank(admin);
        crowdfund.finalize();

        // seeds[67] should get some allocation despite tiny commit
        (uint256 alloc, uint256 refundAmt,) = crowdfund.getAllocation(seeds[67]);

        // Key: alloc (ARM) can be small but shouldn't revert
        // The refundAmt is the USDC not allocated
        // alloc + refundAmt accounting should be consistent
        // (We can't directly check allocUsdc + refund == committed from getAllocation
        //  since getAllocation returns ARM allocation, not USDC allocation)
        assertTrue(alloc > 0 || refundAmt > 0, "should have either allocation or refund");
    }

    // =====================================================================
    // 6.10: Pro-rata with prime number commitments (indivisible)
    // =====================================================================

    function test_6_10_primeCommitmentProRata() public {
        _advanceToCommitment();

        // Use prime-ish amounts within hop cap ($15K)
        uint256 primeAmount0 = 14_983e6; // prime-ish, near cap
        uint256 primeAmount1 = 10_007e6; // prime-ish

        // Fill 66 seeds at full cap to get close to MIN_SALE
        for (uint256 i = 2; i < 68; i++) {
            _commit(seeds[i], HOP0_CAP);
        }

        // seeds[0] and seeds[1] commit prime amounts
        _commit(seeds[0], primeAmount0);
        _commit(seeds[1], primeAmount1);

        _advancePastCommitment();

        vm.prank(admin);
        crowdfund.finalize();

        // Check allocations via getAllocation view
        (uint256 alloc0, uint256 refund0,) = crowdfund.getAllocation(seeds[0]);
        (uint256 alloc1, uint256 refund1,) = crowdfund.getAllocation(seeds[1]);

        // Both should get some ARM allocation
        assertTrue(alloc0 > 0, "seed0 should get ARM allocation");
        assertTrue(alloc1 > 0, "seed1 should get ARM allocation");

        // Verify claims work without revert
        (uint256 armR0, uint256 usdcR0) = _claimAndMeasure(seeds[0]);
        (uint256 armR1, uint256 usdcR1) = _claimAndMeasure(seeds[1]);

        // ARM received should match allocation view
        assertEq(armR0, alloc0, "seed0: ARM received != allocation");
        assertEq(armR1, alloc1, "seed1: ARM received != allocation");

        // USDC refund received should match refund view
        assertEq(usdcR0, refund0, "seed0: USDC refund != expected");
        assertEq(usdcR1, refund1, "seed1: USDC refund != expected");
    }

    // =====================================================================
    // Fuzz: arbitrary commitments within cap, allocation consistency
    // =====================================================================

    function testFuzz_allocationConsistency(uint256 amount) public {
        amount = bound(amount, MIN_COMMIT, HOP0_CAP);

        _advanceToCommitment();

        // Fill 67 seeds at full cap to reach MIN_SALE
        for (uint256 i = 1; i < 68; i++) {
            _commit(seeds[i], HOP0_CAP);
        }
        // seeds[0] commits fuzzed amount
        _commit(seeds[0], amount);

        _advancePastCommitment();

        vm.prank(admin);
        crowdfund.finalize();

        // getAllocation should not revert for a committed participant
        (uint256 alloc, uint256 refundAmt, bool claimed) = crowdfund.getAllocation(seeds[0]);
        assertFalse(claimed);

        // Claim should succeed and match getAllocation
        (uint256 armR, uint256 usdcR) = _claimAndMeasure(seeds[0]);
        assertEq(armR, alloc, "ARM mismatch");
        assertEq(usdcR, refundAmt, "refund mismatch");
    }

    // =====================================================================
    // permissionlessCancel: full flow test
    // =====================================================================

    function test_permissionlessCancelFlow() public {
        _advanceToCommitment();

        // seed0 commits some USDC (well below $1M minimum)
        _commit(seeds[0], HOP0_CAP); // $15K, far below $1M minimum

        // Advance past commitment end
        _advancePastCommitment();

        // Grace period has not elapsed yet - should revert
        vm.prank(anyone);
        vm.expectRevert("ArmadaCrowdfund: grace period not elapsed");
        crowdfund.permissionlessCancel();

        // Advance past grace period (30 days)
        vm.warp(crowdfund.commitmentEnd() + 30 days + 1);

        // Now anyone can cancel
        vm.prank(anyone);
        crowdfund.permissionlessCancel();

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Canceled));

        // seed0 can get full refund
        vm.prank(seeds[0]);
        crowdfund.refund();

        // seed0 balance should be restored
        assertEq(usdc.balanceOf(seeds[0]), HOP0_CAP);
    }

    function test_permissionlessCancelFromInvitation() public {
        // Still in Invitation phase, no commits
        // Advance past grace period
        vm.warp(crowdfund.commitmentEnd() + 30 days + 1);

        // permissionlessCancel works from Invitation phase too
        vm.prank(anyone);
        crowdfund.permissionlessCancel();
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Canceled));
    }

    function test_permissionlessCancelNotFromSetup() public {
        // Deploy a fresh crowdfund that hasn't left Setup
        ArmadaCrowdfund fresh = new ArmadaCrowdfund(
            address(usdc), address(armToken), admin, treasury
        );

        // Even after a long time, Setup phase can't be permissionlessly canceled
        vm.warp(block.timestamp + 365 days);

        vm.prank(anyone);
        vm.expectRevert("ArmadaCrowdfund: not in active phase");
        fresh.permissionlessCancel();
    }

    function test_permissionlessCancelNotFromFinalized() public {
        _fillMinimum();
        _advancePastCommitment();

        vm.prank(admin);
        crowdfund.finalize();

        // Wait past grace period
        vm.warp(block.timestamp + 60 days);

        vm.prank(anyone);
        vm.expectRevert("ArmadaCrowdfund: not in active phase");
        crowdfund.permissionlessCancel();
    }
}

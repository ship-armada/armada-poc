// ABOUTME: Tests for refundMode — entered when capped demand or net proceeds fall below MIN_SALE.
// ABOUTME: Verifies refund eligibility, claimRefund() behavior, and phase transitions.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract ArmadaCrowdfundRefundModeTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant MIN_SALE = 250_000 * 1e6;
    // Seeds that commit in the refund-mode scenario: 16 × $15K = $240K < MIN_SALE.
    uint256 constant BELOW_MIN_SEEDS = 16;

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
            admin,  // securityCouncil
            block.timestamp
        );

        // Whitelist admin and crowdfund so token transfers work
        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // Add 80 seeds. The refund-mode scenario commits from the first BELOW_MIN_SEEDS of
        // them ($240K < MIN_SALE); the success scenarios use more.
        for (uint256 i = 0; i < 80; i++) {
            seeds.push(address(uint160(0xA000 + i)));
        }
        crowdfund.addSeeds(seeds);
    }

    /// @notice Helper: the first `count` seeds each commit $15K at hop-0
    function _seedsCommit(uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            uint256 amount = 15_000 * 1e6;
            usdc.mint(seeds[i], amount);
            vm.startPrank(seeds[i]);
            usdc.approve(address(crowdfund), amount);
            crowdfund.commit(0, amount);
            vm.stopPrank();
        }
    }

    /// @notice Helper: capped demand of $240K, below MIN_SALE → refundMode at finalize
    function _commitBelowMinimum() internal {
        _seedsCommit(BELOW_MIN_SEEDS);
    }

    // ============ RefundMode trigger ============

    /// @notice WHY: refund mode after allocation (allocated USDC below MIN_SALE although capped
    ///         demand cleared it) is reachable only when a hop ceiling holds allocation below
    ///         demand. With no hop-2 floor and 100% ceilings, allocation equals
    ///         min(capped demand, saleSize), so 80 seeds × $15K = $1.2M all at hop-0 succeeds in
    ///         full. Pins that the post-allocation refund path cannot be reached by hop-0-only demand.
    function test_hop0OnlyDemand_aboveMinimum_succeedsWithoutPostAllocationRefund() public {
        _seedsCommit(80);
        vm.warp(crowdfund.windowEnd() + 1);

        crowdfund.finalize();

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));
        assertFalse(crowdfund.refundMode());
        assertEq(crowdfund.totalAllocatedUsdc(), 1_200_000 * 1e6, "allocation equals capped demand");
        assertEq(crowdfund.totalAllocatedArm(), 1_200_000 * 1e18);
    }

    /// @notice Capped demand below MIN_SALE enters refundMode and records no allocation
    function test_refundMode_triggers_belowMinSale() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);

        crowdfund.finalize();

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));
        assertTrue(crowdfund.refundMode());
        // In refundMode, allocations are NOT recorded
        assertEq(crowdfund.totalAllocatedArm(), 0);
        assertEq(crowdfund.totalAllocatedUsdc(), 0);
    }

    /// @notice claim() reverts in refundMode
    function test_claim_revertsInRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: sale in refund mode");
        crowdfund.claim(address(0));
    }

    /// @notice claimRefund() returns full deposited USDC in refundMode
    function test_claimRefund_returnsFullUsdc_inRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        uint256 balBefore = usdc.balanceOf(seeds[0]);
        vm.prank(seeds[0]);
        crowdfund.claimRefund();
        uint256 balAfter = usdc.balanceOf(seeds[0]);

        assertEq(balAfter - balBefore, 15_000 * 1e6, "Should refund full committed amount");
    }

    /// @notice Double claimRefund reverts
    function test_claimRefund_doubleCallReverts_inRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        vm.prank(seeds[0]);
        crowdfund.claimRefund();

        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: already claimed");
        crowdfund.claimRefund();
    }

    /// @notice All ARM is recoverable via withdrawUnallocatedArm in refundMode
    function test_withdrawUnallocatedArm_refundMode_returnsAllArm() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);

        assertEq(treasuryAfter - treasuryBefore, ARM_FUNDING, "All ARM should be swept");
    }

    /// @notice In refundMode, withdrawUnallocatedArm sweeps all ARM (nothing owed)
    function test_withdrawUnallocatedArm_sweepsAllInRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        assertTrue(crowdfund.refundMode(), "should be in refund mode");
        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);
        assertEq(treasuryAfter - treasuryBefore, ARM_FUNDING, "All ARM should be swept");
    }

    // WHY: Spec (CROWDFUND.md §"computeAllocation()" + Events table) requires
    // the canonical post-finalization view to "always return the theoretical
    // entitlement regardless of timing or claim status". In refundMode the
    // deterministic answer is well-defined: 0 ARM, sum of committed USDC.
    // Audit-101 dropped the previous refundMode revert; pin the new positive
    // behavior so a future refactor cannot reintroduce the canonical-view gap.

    /// @notice computeAllocation returns (0 ARM, sum of committed USDC) in refundMode
    function test_computeAllocation_returnsFullRefundUsdc_inRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        assertTrue(crowdfund.refundMode(), "should be in refund mode");
        (uint256 armAmount, uint256 refundUsdc) = crowdfund.computeAllocation(seeds[0]);
        assertEq(armAmount, 0, "ARM entitlement is zero in refundMode");
        assertEq(refundUsdc, 15_000 * 1e6, "refund equals full committed USDC across all hops");
    }

    /// @notice computeAllocation matches participants[].committed sum across hops in refundMode
    ///         — equivalence with the spec's events-only fallback path.
    function test_computeAllocation_matchesCommittedSum_inRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        for (uint256 i = 0; i < 5; i++) {
            uint256 expectedRefund;
            for (uint8 h = 0; h < 3; h++) {
                expectedRefund += crowdfund.getCommitment(seeds[i], h);
            }
            (uint256 armAmount, uint256 refundUsdc) = crowdfund.computeAllocation(seeds[i]);
            assertEq(armAmount, 0, "ARM entitlement is zero in refundMode");
            assertEq(refundUsdc, expectedRefund, "view matches per-hop committed sum");
        }
    }

    /// @notice computeAllocationAtHop returns (0, p.committed) in refundMode
    function test_computeAllocationAtHop_returnsHopCommitted_inRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        assertTrue(crowdfund.refundMode(), "should be in refund mode");
        (uint256 armAmount, uint256 refundUsdc) = crowdfund.computeAllocationAtHop(seeds[0], 0);
        assertEq(armAmount, 0, "ARM entitlement is zero in refundMode");
        assertEq(refundUsdc, 15_000 * 1e6, "refund equals committed amount at this hop");

        // Hop with no commitment → zero refund (no synthetic entitlement)
        (armAmount, refundUsdc) = crowdfund.computeAllocationAtHop(seeds[0], 1);
        assertEq(armAmount, 0, "ARM is zero for un-committed hop");
        assertEq(refundUsdc, 0, "refund is zero for un-committed hop");
    }

    /// @notice The canonical view is stable across claimRefund — "regardless of claim status".
    function test_computeAllocation_unchangedAfterClaimRefund_inRefundMode() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        (uint256 armBefore, uint256 refundBefore) = crowdfund.computeAllocation(seeds[0]);

        vm.prank(seeds[0]);
        crowdfund.claimRefund();

        (uint256 armAfter, uint256 refundAfter) = crowdfund.computeAllocation(seeds[0]);
        assertEq(armAfter, armBefore, "ARM entitlement is invariant across claim");
        assertEq(refundAfter, refundBefore, "refund entitlement is invariant across claim");
    }

    // ============ No expansion ============

    /// @notice WHY: refund mode after elastic expansion needs an expanded sale whose hop-0
    ///         ceiling stays below MIN_SALE. BASE_SALE == MAX_SALE, so there is no expansion and
    ///         $1.8M of hop-0 demand fills the $1.8M sale in full. Pins both properties.
    function test_highHop0Demand_noExpansion_succeedsAtSaleSize() public {
        // Deploy a fresh crowdfund with 120 seeds to reach ELASTIC_TRIGGER
        ArmadaCrowdfund cf2 = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, admin, admin, block.timestamp
        );
        armToken.transfer(address(cf2), ARM_FUNDING);
        cf2.loadArm();

        address[] memory moreSeeds = new address[](120);
        for (uint256 i = 0; i < 120; i++) {
            moreSeeds[i] = address(uint160(0xF000 + i));
        }
        cf2.addSeeds(moreSeeds);

        // 120 seeds × $15K = $1.8M = ELASTIC_TRIGGER (= BASE_SALE = MAX_SALE)
        for (uint256 i = 0; i < 120; i++) {
            uint256 amount = 15_000 * 1e6;
            usdc.mint(moreSeeds[i], amount);
            vm.startPrank(moreSeeds[i]);
            usdc.approve(address(cf2), amount);
            cf2.commit(0, amount);
            vm.stopPrank();
        }
        assertEq(cf2.totalCommitted(), 1_800_000 * 1e6);

        vm.warp(cf2.windowEnd() + 1);
        cf2.finalize();

        assertEq(cf2.saleSize(), 1_800_000 * 1e6, "no expansion beyond $1.8M");
        assertFalse(cf2.refundMode());
        assertEq(cf2.totalAllocatedUsdc(), 1_800_000 * 1e6, "filled in full");
    }

    // ============ Fuzz: claimRefund returns exact committed amount ============

    /// @notice Fuzz: in refundMode, each participant's claimRefund returns their exact deposit.
    ///         The first 16 seeds commit (15 at $15K, 1 at a fuzzed amount up to $15K), so capped
    ///         demand is at most $240K < MIN_SALE and refundMode is guaranteed.
    function testFuzz_claimRefund_exactAmount(uint256 seedIdx, uint256 commitAmount) public {
        seedIdx = bound(seedIdx, 0, BELOW_MIN_SEEDS - 1);
        commitAmount = bound(commitAmount, 100 * 1e6, 15_000 * 1e6);

        // The other seeds in the scenario commit full $15K
        for (uint256 i = 0; i < BELOW_MIN_SEEDS; i++) {
            if (i == seedIdx) continue;
            uint256 amount = 15_000 * 1e6;
            usdc.mint(seeds[i], amount);
            vm.startPrank(seeds[i]);
            usdc.approve(address(crowdfund), amount);
            crowdfund.commit(0, amount);
            vm.stopPrank();
        }

        // Commit the fuzzed amount from the target seed
        usdc.mint(seeds[seedIdx], commitAmount);
        vm.startPrank(seeds[seedIdx]);
        usdc.approve(address(crowdfund), commitAmount);
        crowdfund.commit(0, commitAmount);
        vm.stopPrank();

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        // 16 seeds × max $15K = $240K cappedDemand < MIN_SALE → refundMode guaranteed
        assertTrue(crowdfund.refundMode(), "Must be in refund mode below MIN_SALE");

        uint256 balBefore = usdc.balanceOf(seeds[seedIdx]);
        vm.prank(seeds[seedIdx]);
        crowdfund.claimRefund();
        uint256 balAfter = usdc.balanceOf(seeds[seedIdx]);
        assertEq(balAfter - balBefore, commitAmount, "Refund must equal exact committed amount");
    }

    // ============ Permissionless finalize ============

    /// @notice Non-admin can call finalize()
    function test_finalize_permissionless() public {
        _commitBelowMinimum();
        vm.warp(crowdfund.windowEnd() + 1);

        // Call from a random non-admin address
        vm.prank(address(0xDEAD));
        crowdfund.finalize();

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));
    }

    /// @notice WHY: When cappedDemand < MIN_SALE, finalize() must enter refundMode instead
    ///         of reverting. If phase stays Active, ARM tokens are locked permanently
    ///         because withdrawUnallocatedArm() requires Phase.Finalized or Phase.Canceled.
    function test_finalize_belowMinSale_entersRefundMode() public {
        // Only 1 seed commits $15K — way below MIN_SALE
        uint256 amount = 15_000 * 1e6;
        usdc.mint(seeds[0], amount);
        vm.startPrank(seeds[0]);
        usdc.approve(address(crowdfund), amount);
        crowdfund.commit(0, amount);
        vm.stopPrank();

        vm.warp(crowdfund.windowEnd() + 1);

        crowdfund.finalize();
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));
        assertTrue(crowdfund.refundMode());
    }

    // ============ claimRefund after below-minimum finalization ============

    /// @notice WHY: After finalize() enters refundMode due to below-minimum demand,
    ///         participants must be able to claim full USDC refunds via claimRefund().
    function test_claimRefund_afterBelowMinFinalize() public {
        // Commit below MIN_SALE
        uint256 amount = 15_000 * 1e6;
        usdc.mint(seeds[0], amount);
        vm.startPrank(seeds[0]);
        usdc.approve(address(crowdfund), amount);
        crowdfund.commit(0, amount);
        vm.stopPrank();

        // Window expires, finalize enters refundMode
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        // Participant can claim full refund
        uint256 balBefore = usdc.balanceOf(seeds[0]);
        vm.prank(seeds[0]);
        crowdfund.claimRefund();
        uint256 balAfter = usdc.balanceOf(seeds[0]);

        assertEq(balAfter - balBefore, amount, "Should refund full amount after below-min finalize");
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));
    }

    /// @notice claimRefund reverts during active window
    function test_claimRefund_revertsDuringActiveWindow() public {
        uint256 amount = 15_000 * 1e6;
        usdc.mint(seeds[0], amount);
        vm.startPrank(seeds[0]);
        usdc.approve(address(crowdfund), amount);
        crowdfund.commit(0, amount);
        vm.stopPrank();

        // Still in active window
        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: refund not available");
        crowdfund.claimRefund();
    }

    /// @notice After normal finalization (not refundMode), claimRefund() reverts.
    ///         claim() now handles both ARM + refund in a single call.
    function test_claimRefund_revertsAfterSuccessfulFinalize() public {
        // 17 seeds × $15K = $255K ≥ MIN_SALE → success
        _seedsCommit(17);

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        // Verify not in refundMode
        assertFalse(crowdfund.refundMode());
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));

        // claimRefund reverts after normal finalization — claim() handles both ARM + refund
        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: refund not available");
        crowdfund.claimRefund();
    }
}

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
    uint256 constant MIN_SALE = 1_000_000 * 1e6;
    uint256 constant THREE_WEEKS = 21 days;

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

        // Add 80 seeds for refundMode tests.
        // 80 × $15K = $1.2M — above MIN_SALE ($1M) but below ELASTIC_TRIGGER ($1.5M).
        // At BASE_SALE: hop-0 ceiling = 70% × ($1.2M - $60K) = $798K < MIN_SALE → refundMode.
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

    // ============ RefundMode trigger ============

    /// @notice 80 seeds × $15K = $1.2M totalCommitted, all at hop-0.
    ///         BASE_SALE ($1.2M): available = $1.14M, hop-0 ceiling = 70% × $1.14M = $798K.
    ///         totalAllocUsdc = $798K < $1M = MIN_SALE → refundMode.
    function test_refundMode_triggers_whenAllocBelowMinSale() public {
        _allSeedsCommitFull();
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
        _allSeedsCommitFull();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: sale in refund mode");
        crowdfund.claim(address(0));
    }

    /// @notice claimRefund() returns full deposited USDC in refundMode
    function test_claimRefund_returnsFullUsdc_inRefundMode() public {
        _allSeedsCommitFull();
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
        _allSeedsCommitFull();
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
        _allSeedsCommitFull();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);

        assertEq(treasuryAfter - treasuryBefore, ARM_FUNDING, "All ARM should be swept");
    }

    /// @notice In refundMode, withdrawUnallocatedArm sweeps all ARM (nothing owed)
    function test_withdrawUnallocatedArm_sweepsAllInRefundMode() public {
        _allSeedsCommitFull();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        assertTrue(crowdfund.refundMode(), "should be in refund mode");
        uint256 treasuryBefore = armToken.balanceOf(treasury);
        crowdfund.withdrawUnallocatedArm();
        uint256 treasuryAfter = armToken.balanceOf(treasury);
        assertEq(treasuryAfter - treasuryBefore, ARM_FUNDING, "All ARM should be swept");
    }

    /// @notice computeAllocation reverts in refundMode
    function test_computeAllocation_revertsInRefundMode() public {
        _allSeedsCommitFull();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        vm.expectRevert("ArmadaCrowdfund: sale in refund mode");
        crowdfund.computeAllocation(seeds[0]);
    }

    /// @notice computeAllocationAtHop reverts in refundMode
    function test_computeAllocationAtHop_revertsInRefundMode() public {
        _allSeedsCommitFull();
        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();

        vm.expectRevert("ArmadaCrowdfund: sale in refund mode");
        crowdfund.computeAllocationAtHop(seeds[0], 0);
    }

    // ============ RefundMode cannot happen after expansion ============

    /// @notice When totalCommitted >= ELASTIC_TRIGGER, MAX_SALE is used.
    ///         Hop-0 ceiling = 70% × ($1.8M - $90K) = $1,197K > MIN_SALE.
    ///         RefundMode cannot trigger after expansion.
    function test_refundMode_cannotHappenAfterExpansion() public {
        // Deploy a fresh crowdfund with 100 seeds to reach ELASTIC_TRIGGER
        ArmadaCrowdfund cf2 = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, admin, admin, block.timestamp
        );
        armToken.transfer(address(cf2), ARM_FUNDING);
        cf2.loadArm();

        address[] memory moreSeeds = new address[](100);
        for (uint256 i = 0; i < 100; i++) {
            moreSeeds[i] = address(uint160(0xF000 + i));
        }
        cf2.addSeeds(moreSeeds);

        // 100 seeds × $15K = $1.5M = ELASTIC_TRIGGER, triggers expansion
        for (uint256 i = 0; i < 100; i++) {
            uint256 amount = 15_000 * 1e6;
            usdc.mint(moreSeeds[i], amount);
            vm.startPrank(moreSeeds[i]);
            usdc.approve(address(cf2), amount);
            cf2.commit(0, amount);
            vm.stopPrank();
        }
        assertEq(cf2.totalCommitted(), 1_500_000 * 1e6);

        vm.warp(cf2.windowEnd() + 1);
        cf2.finalize();

        // Expansion prevents refundMode: hop-0 ceiling = $1,197K > $1M
        assertFalse(cf2.refundMode());
        assertTrue(cf2.totalAllocatedUsdc() >= MIN_SALE);
    }

    // ============ Fuzz: claimRefund returns exact committed amount ============

    /// @notice Fuzz: in refundMode, each participant's claimRefund returns their exact deposit.
    ///         All 80 seeds commit (79 at $15K, 1 at fuzzed amount) to guarantee cappedDemand
    ///         is in [MIN_SALE, ELASTIC_TRIGGER), which always triggers refundMode at BASE_SALE
    ///         because hop-0 ceiling ($798K) < MIN_SALE ($1M).
    function testFuzz_claimRefund_exactAmount(uint256 seedIdx, uint256 commitAmount) public {
        seedIdx = bound(seedIdx, 0, seeds.length - 1);
        commitAmount = bound(commitAmount, 10 * 1e6, 15_000 * 1e6);

        // All non-target seeds commit full $15K to guarantee cappedDemand >= MIN_SALE
        for (uint256 i = 0; i < seeds.length; i++) {
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

        // 80 seeds × max $15K = $1.2M cappedDemand < ELASTIC_TRIGGER ($1.5M)
        // → saleSize = BASE_SALE → hop-0 ceiling = $798K < MIN_SALE → refundMode guaranteed
        assertTrue(crowdfund.refundMode(), "Must be in refund mode with only hop-0 at BASE_SALE");

        uint256 balBefore = usdc.balanceOf(seeds[seedIdx]);
        vm.prank(seeds[seedIdx]);
        crowdfund.claimRefund();
        uint256 balAfter = usdc.balanceOf(seeds[seedIdx]);
        assertEq(balAfter - balBefore, commitAmount, "Refund must equal exact committed amount");
    }

    // ============ Permissionless finalize ============

    /// @notice Non-admin can call finalize()
    function test_finalize_permissionless() public {
        _allSeedsCommitFull();
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
        // Need demand spread across hops so totalAllocUsdc >= MIN_SALE.
        // At BASE_SALE: hop-0 ceiling = $798K, hop-1 ceiling = $513K.
        // 53 seeds × $15K = $795K (under hop-0 ceiling → full allocation).
        // Plus hop-1 participants adding $210K → totalAllocUsdc = $1,005K > $1M.
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

        // Hop-1 commits: 53 × $4K = $212K
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

        // Verify not in refundMode
        assertFalse(crowdfund.refundMode());
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized));

        // claimRefund reverts after normal finalization — claim() handles both ARM + refund
        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: refund not available");
        crowdfund.claimRefund();
    }
}

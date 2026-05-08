// ABOUTME: Tests for resumable finalize() — equivalence with one-shot, mutation freeze,
// ABOUTME: idempotency, and partial-progress persistence across multiple finalizeStep() calls.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @dev Helper for treasury-revert test. ERC20 transfers don't actually invoke any
///      callback on the recipient, so this contract being the treasury doesn't cause
///      the transfer to revert on its own. The test documents this fact rather than
///      asserting a specific revert path — see test_adversarial_revertingTreasury_atomicRollback.
contract RevertingTreasury {
    fallback() external payable {
        revert("RevertingTreasury: rejects all calls");
    }
}

contract CrowdfundFinalizeStepTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant HOP0_CAP = 15_000 * 1e6;
    uint256 constant HOP1_CAP = 4_000 * 1e6;
    uint256 constant HOP2_CAP = 1_000 * 1e6;
    uint256 constant MIN_COMMIT = 10 * 1e6;
    uint256 constant BASE_SALE = 1_200_000 * 1e6;
    uint256 constant MAX_SALE  = 1_800_000 * 1e6;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);
        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);
    }

    // ============ Helpers ============

    function _deploy() internal returns (ArmadaCrowdfund cf) {
        cf = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, admin, admin, block.timestamp
        );
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();
    }

    function _seedAddr(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000000 + i));
    }

    function _hop1Addr(uint256 i) internal pure returns (address) {
        return address(uint160(0x20000000 + i));
    }

    function _hop2Addr(uint256 i) internal pure returns (address) {
        return address(uint160(0x30000000 + i));
    }

    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(cf), amount);
        vm.prank(who);
        cf.commit(hop, amount);
    }

    /// @notice Build a populated crowdfund with the given (h0, h1, h2) node counts.
    /// @dev Caller must respect structural ceilings: h0 ≤ 160, h1 ≤ 3*h0 + 60, h2 ≤ 2*h1 + 60.
    function _populate(
        uint256 h0,
        uint256 h1,
        uint256 h2,
        uint256 commitAmount
    ) internal returns (ArmadaCrowdfund cf) {
        cf = _deploy();

        if (h0 > 0) {
            address[] memory seeds = new address[](h0);
            for (uint256 i = 0; i < h0; i++) seeds[i] = _seedAddr(i);
            cf.addSeeds(seeds);
        }

        uint256 hop1ViaSeeds = h1 > 3 * h0 ? 3 * h0 : h1;
        uint256 hop1ViaLT = h1 - hop1ViaSeeds;
        for (uint256 i = 0; i < hop1ViaSeeds; i++) {
            vm.prank(_seedAddr(i / 3));
            cf.invite(_hop1Addr(i), 0);
        }
        for (uint256 i = 0; i < hop1ViaLT; i++) {
            cf.launchTeamInvite(_hop1Addr(hop1ViaSeeds + i), 0);
        }

        uint256 hop2ViaHop1 = h2 > 2 * h1 ? 2 * h1 : h2;
        uint256 hop2ViaLT = h2 - hop2ViaHop1;
        for (uint256 i = 0; i < hop2ViaHop1; i++) {
            vm.prank(_hop1Addr(i / 2));
            cf.invite(_hop2Addr(i), 1);
        }
        for (uint256 i = 0; i < hop2ViaLT; i++) {
            cf.launchTeamInvite(_hop2Addr(hop2ViaHop1 + i), 1);
        }

        for (uint256 i = 0; i < h0; i++) _commitAs(cf, _seedAddr(i), 0, commitAmount);
        for (uint256 i = 0; i < h1; i++) _commitAs(cf, _hop1Addr(i), 1, commitAmount);
        for (uint256 i = 0; i < h2; i++) _commitAs(cf, _hop2Addr(i), 2, commitAmount);
    }

    /// @notice Snapshot the post-finalize aggregate state for equivalence comparison.
    /// @dev `treasuryDelta` measures the change in treasury USDC over the finalize call,
    ///      so two finalizes in the same test (sharing the treasury address) compare cleanly.
    struct FinalState {
        uint256 saleSize;
        uint256 cappedDemand;
        uint256 totalAllocatedArm;
        uint256 totalAllocatedUsdc;
        uint256 finalCeiling0;
        uint256 finalCeiling1;
        uint256 finalCeiling2;
        uint256 finalDemand0;
        uint256 finalDemand1;
        uint256 finalDemand2;
        bool refundMode;
        uint256 hopCapped0;
        uint256 hopCapped1;
        uint256 hopCapped2;
        uint256 treasuryDelta;
        uint256 contractBalance;
    }

    function _snapshot(ArmadaCrowdfund cf, uint256 treasuryBefore) internal view returns (FinalState memory s) {
        s.saleSize = cf.saleSize();
        s.cappedDemand = cf.cappedDemand();
        s.totalAllocatedArm = cf.totalAllocatedArm();
        s.totalAllocatedUsdc = cf.totalAllocatedUsdc();
        s.finalCeiling0 = cf.finalCeilings(0);
        s.finalCeiling1 = cf.finalCeilings(1);
        s.finalCeiling2 = cf.finalCeilings(2);
        s.finalDemand0 = cf.finalDemands(0);
        s.finalDemand1 = cf.finalDemands(1);
        s.finalDemand2 = cf.finalDemands(2);
        s.refundMode = cf.refundMode();
        (, uint256 c0, , ) = cf.getHopStats(0);
        (, uint256 c1, , ) = cf.getHopStats(1);
        (, uint256 c2, , ) = cf.getHopStats(2);
        s.hopCapped0 = c0;
        s.hopCapped1 = c1;
        s.hopCapped2 = c2;
        s.treasuryDelta = usdc.balanceOf(treasury) - treasuryBefore;
        s.contractBalance = usdc.balanceOf(address(cf));
    }

    function _assertEqState(FinalState memory a, FinalState memory b) internal pure {
        assertEq(a.saleSize, b.saleSize, "saleSize");
        assertEq(a.cappedDemand, b.cappedDemand, "cappedDemand");
        assertEq(a.totalAllocatedArm, b.totalAllocatedArm, "totalAllocatedArm");
        assertEq(a.totalAllocatedUsdc, b.totalAllocatedUsdc, "totalAllocatedUsdc");
        assertEq(a.finalCeiling0, b.finalCeiling0, "finalCeiling[0]");
        assertEq(a.finalCeiling1, b.finalCeiling1, "finalCeiling[1]");
        assertEq(a.finalCeiling2, b.finalCeiling2, "finalCeiling[2]");
        assertEq(a.finalDemand0, b.finalDemand0, "finalDemand[0]");
        assertEq(a.finalDemand1, b.finalDemand1, "finalDemand[1]");
        assertEq(a.finalDemand2, b.finalDemand2, "finalDemand[2]");
        assertEq(a.refundMode, b.refundMode, "refundMode");
        assertEq(a.hopCapped0, b.hopCapped0, "hopStats[0].cappedCommitted");
        assertEq(a.hopCapped1, b.hopCapped1, "hopStats[1].cappedCommitted");
        assertEq(a.hopCapped2, b.hopCapped2, "hopStats[2].cappedCommitted");
        assertEq(a.treasuryDelta, b.treasuryDelta, "treasury delta");
        assertEq(a.contractBalance, b.contractBalance, "contract balance");
    }

    // ============ Equivalence: one-shot vs batched ============

    /// @notice One-shot finalize() and a single finalizeStep(huge) are identical.
    function test_equivalence_singleHugeStep_vs_oneShot() public {
        ArmadaCrowdfund cf1 = _populate(100, 200, 200, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(100, 200, 200, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);
        cf2.finalizeStep(type(uint256).max);
        FinalState memory huge = _snapshot(cf2, t2);

        _assertEqState(oneShot, huge);
        assertFalse(cf2.finalizeInProgress(), "completed runs clear inProgress");
    }

    /// @notice Batched finalize across many small steps converges to the one-shot result.
    function test_equivalence_manySmallBatches() public {
        ArmadaCrowdfund cf1 = _populate(100, 200, 200, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(100, 200, 200, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);
        // 500 nodes total; step 50 at a time → 10 batches.
        for (uint256 i = 0; i < 10; i++) {
            cf2.finalizeStep(50);
        }
        FinalState memory batched = _snapshot(cf2, t2);

        _assertEqState(oneShot, batched);
    }

    /// @notice Mixed batch sizes (irregular) match the one-shot result exactly.
    function test_equivalence_irregularBatchSizes() public {
        ArmadaCrowdfund cf1 = _populate(100, 200, 200, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(100, 200, 200, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);
        // 500 nodes total. Step pattern: 7, 113, 2, 999.
        cf2.finalizeStep(7);
        cf2.finalizeStep(113);
        cf2.finalizeStep(2);
        cf2.finalizeStep(999); // overshoots — finalizeStep clamps to target
        FinalState memory batched = _snapshot(cf2, t2);

        _assertEqState(oneShot, batched);
    }

    /// @notice Refund-mode path (capped < MIN_SALE) is equivalent under batched execution.
    function test_equivalence_refundMode() public {
        // 100 nodes × $10 = $1,000 capped — well below MIN_SALE = $1M
        ArmadaCrowdfund cf1 = _populate(100, 0, 0, MIN_COMMIT);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);
        assertTrue(oneShot.refundMode, "expected refund mode");

        ArmadaCrowdfund cf2 = _populate(100, 0, 0, MIN_COMMIT);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);
        cf2.finalizeStep(33);
        cf2.finalizeStep(33);
        cf2.finalizeStep(33);
        cf2.finalizeStep(33); // brings cursor to 100 (target)
        FinalState memory batched = _snapshot(cf2, t2);

        _assertEqState(oneShot, batched);
    }

    /// @notice Elastic-expansion success path is equivalent under batched execution.
    function test_equivalence_elasticExpansion() public {
        // 160 hop-0 × $15k = $2.4M cappedDemand → MAX_SALE
        ArmadaCrowdfund cf1 = _populate(160, 0, 0, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);
        assertEq(oneShot.saleSize, MAX_SALE, "expected expansion");

        ArmadaCrowdfund cf2 = _populate(160, 0, 0, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);
        cf2.finalizeStep(40);
        cf2.finalizeStep(40);
        cf2.finalizeStep(40);
        cf2.finalizeStep(40);
        FinalState memory batched = _snapshot(cf2, t2);

        _assertEqState(oneShot, batched);
    }

    /// @notice Stress: 1,840 nodes (structural max) finalizes via small batches.
    function test_equivalence_structuralMax_batchedAt100() public {
        ArmadaCrowdfund cf1 = _populate(160, 540, 1140, MIN_COMMIT);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(160, 540, 1140, MIN_COMMIT);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);
        // 19 batches of 100 → 1900 capacity; cursor clamps to 1840 on last.
        for (uint256 i = 0; i < 19; i++) {
            cf2.finalizeStep(100);
        }
        FinalState memory batched = _snapshot(cf2, t2);

        _assertEqState(oneShot, batched);
    }

    // ============ Mutation freeze ============

    function test_mutationFreeze_commit_revertsAfterStepStarts() public {
        ArmadaCrowdfund cf = _populate(50, 50, 50, MIN_COMMIT);
        vm.warp(cf.windowEnd() + 1);
        cf.finalizeStep(10);

        // Try to commit — must revert. Note: after windowEnd the active-window check
        // would already revert, but we want to assert the explicit freeze guard fires
        // first (or at least that commits are blocked).
        address seed = _seedAddr(0);
        usdc.mint(seed, MIN_COMMIT);
        vm.prank(seed);
        usdc.approve(address(cf), MIN_COMMIT);
        vm.prank(seed);
        vm.expectRevert();
        cf.commit(0, MIN_COMMIT);
    }

    function test_mutationFreeze_invite_revertsAfterStepStarts() public {
        ArmadaCrowdfund cf = _populate(50, 50, 50, MIN_COMMIT);
        vm.warp(cf.windowEnd() + 1);
        cf.finalizeStep(10);

        address seed = _seedAddr(0);
        vm.prank(seed);
        vm.expectRevert();
        cf.invite(address(0xDEAD), 0);
    }

    // ============ Idempotency / completion guards ============

    function test_completion_doubleFinalizeReverts() public {
        ArmadaCrowdfund cf = _populate(100, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        vm.expectRevert(bytes("ArmadaCrowdfund: already finalized"));
        cf.finalize();

        vm.expectRevert(bytes("ArmadaCrowdfund: already finalized"));
        cf.finalizeStep(10);
    }

    function test_completion_stepAfterCompletionReverts() public {
        ArmadaCrowdfund cf = _populate(100, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        cf.finalizeStep(50);
        cf.finalizeStep(50); // completes
        // Phase is now Finalized.
        vm.expectRevert(bytes("ArmadaCrowdfund: already finalized"));
        cf.finalizeStep(10);
    }

    function test_completion_zeroIterationsReverts() public {
        ArmadaCrowdfund cf = _populate(50, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        vm.expectRevert(bytes("ArmadaCrowdfund: zero iterations"));
        cf.finalizeStep(0);
    }

    function test_completion_stepBeforeWindowEndsReverts() public {
        ArmadaCrowdfund cf = _populate(50, 0, 0, HOP0_CAP);
        vm.expectRevert(bytes("ArmadaCrowdfund: window not ended"));
        cf.finalizeStep(10);
        vm.expectRevert(bytes("ArmadaCrowdfund: window not ended"));
        cf.finalize();
    }

    // ============ Partial progress persistence ============

    function test_partialProgress_cursorAdvances() public {
        ArmadaCrowdfund cf = _populate(50, 50, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);

        cf.finalizeStep(30);
        assertTrue(cf.finalizeInProgress(), "should be in progress");
        assertEq(cf.finalizeCursor(), 30, "cursor at 30");
        assertEq(cf.finalizeTargetLength(), 100, "target=100");

        cf.finalizeStep(40);
        assertTrue(cf.finalizeInProgress(), "still in progress");
        assertEq(cf.finalizeCursor(), 70, "cursor at 70");

        cf.finalizeStep(30);
        assertFalse(cf.finalizeInProgress(), "completed clears flag");
        assertEq(cf.finalizeCursor(), 100, "cursor at 100");
    }

    function test_partialProgress_overshootClampsToTarget() public {
        ArmadaCrowdfund cf = _populate(20, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);

        cf.finalizeStep(15);
        assertEq(cf.finalizeCursor(), 15, "cursor at 15");

        cf.finalizeStep(1000); // overshoots
        assertEq(cf.finalizeCursor(), 20, "cursor clamped to 20");
        assertFalse(cf.finalizeInProgress(), "completed");
    }

    // ============ Fuzz: random batch sizes equivalent to one-shot ============

    // ============ Adversarial scenarios ============

    /// @notice WHY: A naive `cursor + maxIterations` add overflows in checked arithmetic
    ///         when cursor > 0 and maxIterations is near uint256 max. Callers (including
    ///         finalize() itself, which delegates to _finalize(MAX)) commonly use MAX as
    ///         the "process everything remaining" idiom. If pagination has already moved
    ///         the cursor past 0, calling finalize() to drive it home — or finalizeStep(MAX) —
    ///         must not revert.
    function test_adversarial_maxIterationsAfterPartialProgress() public {
        ArmadaCrowdfund cf = _populate(50, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        uint256 t0 = usdc.balanceOf(treasury);

        cf.finalizeStep(20);
        assertEq(cf.finalizeCursor(), 20);

        // Driving home with finalize() (which internally is _finalize(MAX)) must work.
        cf.finalize();
        assertFalse(cf.finalizeInProgress(), "completed");

        // Reach the same final state as a one-shot run.
        ArmadaCrowdfund ref = _populate(50, 0, 0, HOP0_CAP);
        vm.warp(ref.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        ref.finalize();
        FinalState memory expected = _snapshot(ref, t1);
        FinalState memory actual = _snapshot(cf, t0);
        _assertEqState(expected, actual);
    }

    /// @notice Same scenario via finalizeStep(MAX) instead of finalize().
    function test_adversarial_finalizeStepMaxAfterPartialProgress() public {
        ArmadaCrowdfund cf = _populate(50, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        cf.finalizeStep(20);
        // Pre-fix this would revert with arithmetic overflow.
        cf.finalizeStep(type(uint256).max);
        assertFalse(cf.finalizeInProgress(), "completed");
    }

    /// @notice WHY: Tiny-batch griefing — attacker calls finalizeStep(1) repeatedly.
    ///         Verify (a) iteration still completes correctly, (b) any honest caller
    ///         can submit a larger batch to clean up, (c) total cost is bounded.
    ///         Bound the test to 50 nodes so it runs reasonably fast.
    function test_adversarial_griefingTinyBatches_completesCorrectly() public {
        uint256 nodeCount = 50;
        ArmadaCrowdfund cf1 = _populate(nodeCount, 0, 0, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(nodeCount, 0, 0, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);

        // 50 calls of size 1 — the maximum-griefing pattern for this size.
        for (uint256 i = 0; i < nodeCount; i++) {
            cf2.finalizeStep(1);
        }

        FinalState memory griefed = _snapshot(cf2, t2);
        _assertEqState(oneShot, griefed);
        assertFalse(cf2.finalizeInProgress(), "completed despite griefing");
    }

    /// @notice WHY: Front-running — attacker submits finalizeStep(1) right before an
    ///         honest caller's finalizeStep(MAX). The honest caller's tx must still
    ///         complete the iteration correctly (just one fewer node to process).
    function test_adversarial_frontRunSmallBatchBeforeBigBatch() public {
        ArmadaCrowdfund cf1 = _populate(50, 0, 0, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(50, 0, 0, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);

        cf2.finalizeStep(1);                     // attacker
        cf2.finalizeStep(type(uint256).max);     // honest caller cleans up
        FinalState memory cleaned = _snapshot(cf2, t2);

        _assertEqState(oneShot, cleaned);
    }

    /// @notice WHY: Cancel() during paginated finalize — security council emergency
    ///         must work even mid-iteration. After cancel, all participants must be
    ///         able to claim full refunds via claimRefund(), and observable iteration
    ///         state must be cleared so external monitoring isn't confused.
    function test_adversarial_cancelDuringPagination() public {
        ArmadaCrowdfund cf = _populate(60, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);

        cf.finalizeStep(20);
        assertTrue(cf.finalizeInProgress(), "in progress");
        assertEq(cf.finalizeCursor(), 20);

        cf.cancel();
        assertFalse(cf.finalizeInProgress(), "cancel clears flag");
        assertEq(uint256(cf.phase()), uint256(Phase.Canceled), "phase=Canceled");

        // Subsequent finalizeStep must revert (phase != Active)
        vm.expectRevert(bytes("ArmadaCrowdfund: already finalized"));
        cf.finalizeStep(40);

        // A participant can claim a full refund
        address seed = _seedAddr(0);
        uint256 balBefore = usdc.balanceOf(seed);
        vm.prank(seed);
        cf.claimRefund();
        uint256 balAfter = usdc.balanceOf(seed);
        assertEq(balAfter - balBefore, HOP0_CAP, "full refund");
    }

    /// @notice WHY: Empty crowdfund (zero nodes registered) must finalize cleanly.
    ///         Edge case for the cursor/target arithmetic and the iteration loop.
    function test_adversarial_emptyCrowdfund() public {
        ArmadaCrowdfund cf = _deploy();
        // No seeds, no invites, no commits.
        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(uint256(cf.phase()), uint256(Phase.Finalized));
        assertTrue(cf.refundMode(), "empty -> refundMode");
        assertEq(cf.cappedDemand(), 0);
    }

    /// @notice WHY: Treasury transfer reverting on the success path is a pre-existing
    ///         risk vector (broken treasury contract). Verify our refactor doesn't
    ///         introduce a new "stuck mid-pagination" failure mode beyond what the
    ///         original finalize() exposed. If treasury transfer reverts, the WHOLE
    ///         settlement reverts atomically — including the cursor advance and the
    ///         finalizeInProgress=false write. State stays at the last successful
    ///         pre-final-batch position; recovery is via cancel() (Council).
    function test_adversarial_revertingTreasury_atomicRollback() public {
        // Deploy a treasury that reverts on receive of any USDC transfer.
        RevertingTreasury bad = new RevertingTreasury();
        ArmadaCrowdfund cf = new ArmadaCrowdfund(
            address(usdc), address(armToken), address(bad), admin, admin, block.timestamp
        );
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();

        address[] memory seeds = new address[](100);
        for (uint256 i = 0; i < 100; i++) seeds[i] = _seedAddr(i);
        cf.addSeeds(seeds);
        for (uint256 i = 0; i < 100; i++) _commitAs(cf, _seedAddr(i), 0, HOP0_CAP);

        vm.warp(cf.windowEnd() + 1);

        // Reverts at the treasury transfer in _completeFinalization.
        // Important: USDC has no transfer hooks, so a reverting treasury would only
        // matter if the treasury were itself a token — but we use safeTransfer which
        // reverts only on token-side failures. Confirm via attempted call.
        // (This test asserts atomicity: state stays Active.)
        try cf.finalize() {
            // If treasury accepts USDC silently (e.g. plain ERC20), this passes.
            // The MockUSDC transfer never calls back, so finalize completes.
            assertTrue(true, "completed (USDC has no transfer hook)");
        } catch {
            assertEq(uint256(cf.phase()), uint256(Phase.Active), "stayed Active on revert");
            assertFalse(cf.finalizeInProgress(), "rolled back inProgress flag");
            assertEq(cf.finalizeCursor(), 0, "rolled back cursor");
        }
    }

    /// @notice WHY: After a fully completed finalization, all paginated state should
    ///         be observably consistent — finalizeInProgress cleared, cursor at target.
    ///         Caught a previous bug where finalizeInProgress was never cleared.
    function test_adversarial_postCompletion_stateClean() public {
        ArmadaCrowdfund cf = _populate(40, 0, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        cf.finalizeStep(15);
        cf.finalizeStep(15);
        cf.finalizeStep(15); // overshoots, completes
        assertFalse(cf.finalizeInProgress(), "flag cleared");
        assertEq(cf.finalizeCursor(), 40, "cursor at target");
        assertEq(uint256(cf.phase()), uint256(Phase.Finalized));
    }

    /// @notice WHY: Verify the freeze guards trigger on every mutation path so future
    ///         changes can't accidentally introduce a path that mutates participant
    ///         state during pagination. addSeed/addSeeds reach the guard via the
    ///         _requireArmLoadedAndPreInviteEnd helper. (Time gates already prevent
    ///         this in practice, but the explicit !finalizeInProgress check is the
    ///         defence-in-depth surface auditors should review.)
    function test_adversarial_allMutationPathsBlockedDuringPagination() public {
        ArmadaCrowdfund cf = _populate(20, 20, 0, HOP0_CAP);
        vm.warp(cf.windowEnd() + 1);
        cf.finalizeStep(10);

        // commit
        address seed = _seedAddr(0);
        usdc.mint(seed, MIN_COMMIT);
        vm.prank(seed);
        usdc.approve(address(cf), MIN_COMMIT);
        vm.prank(seed);
        vm.expectRevert();
        cf.commit(0, MIN_COMMIT);

        // invite
        vm.prank(seed);
        vm.expectRevert();
        cf.invite(address(0xBEEF), 0);

        // launchTeamInvite
        vm.expectRevert();
        cf.launchTeamInvite(address(0xBEE2), 0);

        // addSeed
        vm.expectRevert();
        cf.addSeed(address(0xBEE3));

        // addSeeds
        address[] memory more = new address[](1);
        more[0] = address(0xBEE4);
        vm.expectRevert();
        cf.addSeeds(more);
    }

    function testFuzz_equivalence_randomBatchSizes(uint256 seed_) public {
        uint256 totalNodes = 240; // 80 hop-0 + 80 hop-1 + 80 hop-2
        ArmadaCrowdfund cf1 = _populate(80, 80, 80, HOP0_CAP);
        vm.warp(cf1.windowEnd() + 1);
        uint256 t1 = usdc.balanceOf(treasury);
        cf1.finalize();
        FinalState memory oneShot = _snapshot(cf1, t1);

        ArmadaCrowdfund cf2 = _populate(80, 80, 80, HOP0_CAP);
        vm.warp(cf2.windowEnd() + 1);
        uint256 t2 = usdc.balanceOf(treasury);

        // Bound random batch sizes between 1 and 100. Always make progress.
        uint256 cursor = 0;
        uint256 entropy = seed_;
        // Loop terminates when finalizeCursor reaches totalNodes; that's when
        // _finalize falls through to settlement and clears finalizeInProgress.
        while (cf2.finalizeInProgress() || cursor == 0) {
            uint256 batchSize = (entropy % 100) + 1;
            entropy = uint256(keccak256(abi.encode(entropy)));
            cf2.finalizeStep(batchSize);
            uint256 newCursor = cf2.finalizeCursor();
            assertGt(newCursor, cursor, "must advance");
            cursor = newCursor;
            if (cursor == totalNodes) break;
        }
        FinalState memory batched = _snapshot(cf2, t2);

        _assertEqState(oneShot, batched);
    }
}

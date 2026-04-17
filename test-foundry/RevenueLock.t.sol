// SPDX-License-Identifier: MIT
// ABOUTME: Foundry unit and fuzz tests for RevenueLock — constructor validation, release mechanics, and view functions.
// ABOUTME: Covers milestone step function, atomic delegation, multi-beneficiary release, and edge cases.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/RevenueLock.sol";
import "../contracts/governance/ArmadaToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @dev Mock RevenueCounter for testing (same pattern as ArmadaWindDown.t.sol)
contract MockRevenueCounterRL {
    uint256 public recognizedRevenueUsd;

    function setRevenue(uint256 _revenue) external {
        recognizedRevenueUsd = _revenue;
    }
}

contract RevenueLockTest is Test {
    // Mirror events
    event Released(address indexed beneficiary, uint256 amount, address delegatee, uint256 cumulativeReleased);

    RevenueLock public revenueLock;
    ArmadaToken public armToken;
    MockRevenueCounterRL public revenueCounter;
    TimelockController public timelock;

    address public deployer = address(this);
    address public beneficiaryA = address(0xA11CE);
    address public beneficiaryB = address(0xB0B);
    address public beneficiaryC = address(0xCA401);
    address public delegateeX = address(0xDE1E);
    address public delegateeY = address(0xDE2E);
    address public nonBeneficiary = address(0xBAD);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant ALLOC_A = 1_200_000 * 1e18; // 10% of supply
    uint256 constant ALLOC_B = 800_000 * 1e18;   // ~6.7%
    uint256 constant ALLOC_C = 400_000 * 1e18;   // ~3.3%
    uint256 constant TOTAL_LOCK = ALLOC_A + ALLOC_B + ALLOC_C; // 2,400,000 ARM

    // $10k/day, 18-decimal USD. Matches PARAMETER_MANIFEST.md / issue #225.
    // With this cap, full unlock requires the ratchet to walk ≥100 days from $0 → $1M.
    uint256 constant MAX_INCREASE_PER_DAY = 10_000e18;

    function setUp() public {
        // Deploy mock revenue counter
        revenueCounter = new MockRevenueCounterRL();

        // Deploy timelock
        address[] memory empty = new address[](0);
        timelock = new TimelockController(2 days, empty, empty, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Setup beneficiary arrays
        address[] memory beneficiaries = new address[](3);
        beneficiaries[0] = beneficiaryA;
        beneficiaries[1] = beneficiaryB;
        beneficiaries[2] = beneficiaryC;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = ALLOC_A;
        amounts[1] = ALLOC_B;
        amounts[2] = ALLOC_C;

        // Deploy RevenueLock
        revenueLock = new RevenueLock(
            address(armToken),
            address(revenueCounter),
            MAX_INCREASE_PER_DAY,
            beneficiaries,
            amounts
        );

        // Whitelist RevenueLock + beneficiaries for transfers
        address[] memory whitelist = new address[](5);
        whitelist[0] = deployer;
        whitelist[1] = address(revenueLock);
        whitelist[2] = beneficiaryA;
        whitelist[3] = beneficiaryB;
        whitelist[4] = beneficiaryC;
        armToken.initWhitelist(whitelist);

        // Authorize RevenueLock for delegateOnBehalf
        address[] memory delegators = new address[](1);
        delegators[0] = address(revenueLock);
        armToken.initAuthorizedDelegators(delegators);

        // Fund RevenueLock with ARM
        armToken.transfer(address(revenueLock), TOTAL_LOCK);

        // Mine a block so getPastVotes works
        vm.roll(block.number + 1);
    }

    /// @dev Set mock-counter revenue AND warp enough wall-clock time that the
    ///      ratchet budget can absorb the full increment. Isolates milestone /
    ///      release mechanics from rate-limit behavior (which has its own section
    ///      below and must NOT use this helper).
    function _setRevenueAndBudget(uint256 revenue) internal {
        revenueCounter.setRevenue(revenue);
        uint256 current = revenueLock.maxObservedRevenue();
        if (revenue > current) {
            uint256 needed = revenue - current;
            uint256 daysNeeded = (needed / MAX_INCREASE_PER_DAY) + 1;
            vm.warp(block.timestamp + daysNeeded * 1 days);
        }
    }

    // ============ Constructor Tests ============

    function test_constructor_setsImmutables() public {
        assertEq(address(revenueLock.armToken()), address(armToken));
        assertEq(address(revenueLock.revenueCounter()), address(revenueCounter));
        assertEq(revenueLock.totalAllocation(), TOTAL_LOCK);
        assertEq(revenueLock.beneficiaryCount(), 3);
    }

    function test_constructor_setsAllocations() public {
        assertEq(revenueLock.allocation(beneficiaryA), ALLOC_A);
        assertEq(revenueLock.allocation(beneficiaryB), ALLOC_B);
        assertEq(revenueLock.allocation(beneficiaryC), ALLOC_C);
    }

    function test_constructor_initialReleasedIsZero() public {
        assertEq(revenueLock.released(beneficiaryA), 0);
        assertEq(revenueLock.released(beneficiaryB), 0);
        assertEq(revenueLock.released(beneficiaryC), 0);
    }

    function test_constructor_zeroArmToken_reverts() public {
        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: zero armToken");
        new RevenueLock(address(0), address(revenueCounter), MAX_INCREASE_PER_DAY, b, a);
    }

    function test_constructor_zeroRevenueCounter_reverts() public {
        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: zero revenueCounter");
        new RevenueLock(address(armToken), address(0), MAX_INCREASE_PER_DAY, b, a);
    }

    // WHY: a zero MAX_REVENUE_INCREASE_PER_DAY would permanently pin
    //      maxObservedRevenue to 0 (budget is always 0), permanently freezing all
    //      entitlements. The constructor must reject this misconfiguration.
    function test_constructor_zeroMaxIncrease_reverts() public {
        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: zero maxIncrease");
        new RevenueLock(address(armToken), address(revenueCounter), 0, b, a);
    }

    function test_constructor_emptyBeneficiaries_reverts() public {
        address[] memory b = new address[](0);
        uint256[] memory a = new uint256[](0);

        vm.expectRevert("RevenueLock: empty beneficiaries");
        new RevenueLock(address(armToken), address(revenueCounter), MAX_INCREASE_PER_DAY, b, a);
    }

    function test_constructor_lengthMismatch_reverts() public {
        address[] memory b = new address[](2);
        b[0] = beneficiaryA;
        b[1] = beneficiaryB;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: length mismatch");
        new RevenueLock(address(armToken), address(revenueCounter), MAX_INCREASE_PER_DAY, b, a);
    }

    function test_constructor_zeroBeneficiaryAddress_reverts() public {
        address[] memory b = new address[](1);
        b[0] = address(0);
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: zero beneficiary");
        new RevenueLock(address(armToken), address(revenueCounter), MAX_INCREASE_PER_DAY, b, a);
    }

    function test_constructor_zeroAmount_reverts() public {
        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 0;

        vm.expectRevert("RevenueLock: zero amount");
        new RevenueLock(address(armToken), address(revenueCounter), MAX_INCREASE_PER_DAY, b, a);
    }

    function test_constructor_duplicateBeneficiary_reverts() public {
        address[] memory b = new address[](2);
        b[0] = beneficiaryA;
        b[1] = beneficiaryA;
        uint256[] memory a = new uint256[](2);
        a[0] = 1e18;
        a[1] = 1e18;

        vm.expectRevert("RevenueLock: duplicate beneficiary");
        new RevenueLock(address(armToken), address(revenueCounter), MAX_INCREASE_PER_DAY, b, a);
    }

    // WHY: the issue #225 auditor checklist explicitly requires that
    //      lastSyncTimestamp is initialized to block.timestamp (NOT 0). A zero
    //      initialization would make the first observation see
    //      `elapsed == block.timestamp`, producing an unbounded budget that
    //      completely bypasses the rate limit on day 1.
    function test_constructor_lastSyncTimestampInitializedToNow() public {
        assertEq(revenueLock.lastSyncTimestamp(), block.timestamp, "lastSyncTimestamp must be now");
        assertGt(revenueLock.lastSyncTimestamp(), 0, "lastSyncTimestamp must not be 0");
    }

    // WHY: the issue #225 auditor checklist also requires that maxObservedRevenue
    //      is NOT seeded from the counter. A malicious initial counter
    //      implementation could otherwise start the ratchet at an arbitrary high
    //      value and bypass the rate limit immediately.
    function test_constructor_maxObservedRevenueStartsAtZero() public {
        // Even if the counter reports a nonzero value at deployment, the ratchet
        // must start at 0. Deploy a fresh lock against a pre-populated counter
        // and confirm.
        MockRevenueCounterRL prePopulated = new MockRevenueCounterRL();
        prePopulated.setRevenue(1_000_000e18);

        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        RevenueLock freshLock = new RevenueLock(
            address(armToken),
            address(prePopulated),
            MAX_INCREASE_PER_DAY,
            b,
            a
        );
        assertEq(freshLock.maxObservedRevenue(), 0, "maxObservedRevenue must start at 0");
    }

    function test_constructor_maxIncreasePerDaySet() public {
        assertEq(revenueLock.MAX_REVENUE_INCREASE_PER_DAY(), MAX_INCREASE_PER_DAY);
    }

    // ============ View Function Tests ============

    function test_allocation_unknownAddress_returnsZero() public {
        assertEq(revenueLock.allocation(nonBeneficiary), 0);
    }

    function test_unlockPercentage_zeroRevenue() public {
        assertEq(revenueLock.unlockPercentage(), 0);
    }

    function test_unlockPercentage_belowFirstMilestone() public {
        _setRevenueAndBudget(9_999e18);
        assertEq(revenueLock.unlockPercentage(), 0);
    }

    function test_unlockPercentage_atFirstMilestone() public {
        _setRevenueAndBudget(10_000e18);
        assertEq(revenueLock.unlockPercentage(), 1000); // 10%
    }

    function test_unlockPercentage_betweenMilestones() public {
        _setRevenueAndBudget(49_999e18);
        assertEq(revenueLock.unlockPercentage(), 1000); // still 10%, step function
    }

    function test_unlockPercentage_atSecondMilestone() public {
        _setRevenueAndBudget(50_000e18);
        assertEq(revenueLock.unlockPercentage(), 2500); // 25%
    }

    function test_unlockPercentage_atThirdMilestone() public {
        _setRevenueAndBudget(100_000e18);
        assertEq(revenueLock.unlockPercentage(), 4000); // 40%
    }

    function test_unlockPercentage_atFourthMilestone() public {
        _setRevenueAndBudget(250_000e18);
        assertEq(revenueLock.unlockPercentage(), 6000); // 60%
    }

    function test_unlockPercentage_atFifthMilestone() public {
        _setRevenueAndBudget(500_000e18);
        assertEq(revenueLock.unlockPercentage(), 8000); // 80%
    }

    function test_unlockPercentage_atSixthMilestone() public {
        _setRevenueAndBudget(1_000_000e18);
        assertEq(revenueLock.unlockPercentage(), 10000); // 100%
    }

    function test_unlockPercentage_aboveMaxMilestone() public {
        _setRevenueAndBudget(5_000_000e18);
        assertEq(revenueLock.unlockPercentage(), 10000); // still 100%
    }

    function test_currentRevenue_readsCounter() public {
        _setRevenueAndBudget(42e18);
        assertEq(revenueLock.currentRevenue(), 42e18);
    }

    function test_releasable_zeroRevenue() public {
        assertEq(revenueLock.releasable(beneficiaryA), 0);
    }

    function test_releasable_nonBeneficiary() public {
        _setRevenueAndBudget(1_000_000e18);
        assertEq(revenueLock.releasable(nonBeneficiary), 0);
    }

    function test_releasable_atFirstMilestone() public {
        _setRevenueAndBudget(10_000e18);
        // 10% of ALLOC_A = 120,000 ARM
        assertEq(revenueLock.releasable(beneficiaryA), ALLOC_A * 1000 / 10000);
    }

    // ============ Release Tests ============

    function test_release_nonBeneficiary_reverts() public {
        _setRevenueAndBudget(10_000e18);
        vm.prank(nonBeneficiary);
        vm.expectRevert("RevenueLock: not a beneficiary");
        revenueLock.release(delegateeX);
    }

    function test_release_zeroDelegatee_reverts() public {
        _setRevenueAndBudget(10_000e18);
        vm.prank(beneficiaryA);
        vm.expectRevert("RevenueLock: zero delegatee");
        revenueLock.release(address(0));
    }

    function test_release_zeroRevenue_reverts() public {
        vm.prank(beneficiaryA);
        vm.expectRevert("RevenueLock: nothing to release");
        revenueLock.release(delegateeX);
    }

    function test_release_atFirstMilestone_transfers10Percent() public {
        _setRevenueAndBudget(10_000e18);

        uint256 expected = ALLOC_A * 1000 / 10000; // 10%
        uint256 balBefore = armToken.balanceOf(beneficiaryA);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        assertEq(armToken.balanceOf(beneficiaryA), balBefore + expected);
        assertEq(revenueLock.released(beneficiaryA), expected);
    }

    function test_release_delegatesToSpecifiedAddress() public {
        _setRevenueAndBudget(10_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        assertEq(armToken.delegates(beneficiaryA), delegateeX);
    }

    function test_release_secondCallAtSameMilestone_reverts() public {
        _setRevenueAndBudget(10_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        vm.prank(beneficiaryA);
        vm.expectRevert("RevenueLock: nothing to release");
        revenueLock.release(delegateeX);
    }

    function test_release_atSecondMilestone_transfersDelta() public {
        // First release at 10%
        _setRevenueAndBudget(10_000e18);
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        uint256 firstRelease = ALLOC_A * 1000 / 10000;

        // Revenue increases to $50k (25%)
        _setRevenueAndBudget(50_000e18);
        uint256 balBefore = armToken.balanceOf(beneficiaryA);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        uint256 secondRelease = (ALLOC_A * 2500 / 10000) - firstRelease;
        assertEq(armToken.balanceOf(beneficiaryA), balBefore + secondRelease);
        assertEq(revenueLock.released(beneficiaryA), firstRelease + secondRelease);
    }

    function test_release_atFullUnlock_transfersEverything() public {
        _setRevenueAndBudget(1_000_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        assertEq(revenueLock.released(beneficiaryA), ALLOC_A);
        assertEq(armToken.balanceOf(beneficiaryA), ALLOC_A);
        assertEq(revenueLock.releasable(beneficiaryA), 0);
    }

    function test_release_emitsEvent() public {
        _setRevenueAndBudget(10_000e18);
        uint256 expectedAmount = ALLOC_A * 1000 / 10000;

        vm.expectEmit(true, false, false, true);
        emit Released(beneficiaryA, expectedAmount, delegateeX, expectedAmount);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
    }

    function test_release_multipleBeneficiariesIndependent() public {
        _setRevenueAndBudget(100_000e18); // 40% unlock

        // Beneficiary A releases
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        assertEq(revenueLock.released(beneficiaryA), ALLOC_A * 4000 / 10000);

        // Beneficiary B releases independently
        vm.prank(beneficiaryB);
        revenueLock.release(delegateeY);
        assertEq(revenueLock.released(beneficiaryB), ALLOC_B * 4000 / 10000);

        // Beneficiary C hasn't released — still zero
        assertEq(revenueLock.released(beneficiaryC), 0);
        assertEq(revenueLock.releasable(beneficiaryC), ALLOC_C * 4000 / 10000);
    }

    function test_release_changesDelegatee() public {
        _setRevenueAndBudget(10_000e18);

        // First release: delegate to X
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        assertEq(armToken.delegates(beneficiaryA), delegateeX);

        // Increase revenue, release again with different delegatee
        _setRevenueAndBudget(50_000e18);
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeY);
        assertEq(armToken.delegates(beneficiaryA), delegateeY);
    }

    function test_release_selfDelegation() public {
        _setRevenueAndBudget(10_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(beneficiaryA);

        assertEq(armToken.delegates(beneficiaryA), beneficiaryA);
        uint256 expectedVotes = ALLOC_A * 1000 / 10000;
        assertEq(armToken.getVotes(beneficiaryA), expectedVotes);
    }

    function test_release_fullLifecycle_allMilestones() public {
        uint256[6] memory thresholds = [uint256(10_000e18), 50_000e18, 100_000e18, 250_000e18, 500_000e18, 1_000_000e18];
        uint256[6] memory bps = [uint256(1000), 2500, 4000, 6000, 8000, 10000];

        uint256 prevReleased = 0;

        for (uint256 i = 0; i < 6; i++) {
            _setRevenueAndBudget(thresholds[i]);
            uint256 entitled = ALLOC_A * bps[i] / 10000;
            uint256 expectedDelta = entitled - prevReleased;

            vm.prank(beneficiaryA);
            revenueLock.release(delegateeX);

            assertEq(revenueLock.released(beneficiaryA), entitled, "wrong cumulative release");
            prevReleased = entitled;
        }

        // Fully released
        assertEq(revenueLock.released(beneficiaryA), ALLOC_A);
        assertEq(revenueLock.releasable(beneficiaryA), 0);
    }

    function test_supplyConservation_afterReleases() public {
        _setRevenueAndBudget(250_000e18); // 60%

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        vm.prank(beneficiaryB);
        revenueLock.release(delegateeX);

        uint256 lockBalance = armToken.balanceOf(address(revenueLock));
        uint256 totalReleased = revenueLock.released(beneficiaryA)
            + revenueLock.released(beneficiaryB)
            + revenueLock.released(beneficiaryC);

        assertEq(lockBalance + totalReleased, TOTAL_LOCK, "supply conservation violated");
    }

    // ============ Fuzz Tests ============

    function testFuzz_unlockPercentage_monotonic(uint256 rev1, uint256 rev2) public {
        rev1 = bound(rev1, 0, 10_000_000e18);
        rev2 = bound(rev2, rev1, 10_000_000e18);

        revenueCounter.setRevenue(rev1);
        uint256 pct1 = revenueLock.unlockPercentage();

        revenueCounter.setRevenue(rev2);
        uint256 pct2 = revenueLock.unlockPercentage();

        assertGe(pct2, pct1, "unlock percentage not monotonic");
    }

    function testFuzz_release_neverExceedsAllocation(uint256 revenue) public {
        revenue = bound(revenue, 0, 10_000_000e18);
        revenueCounter.setRevenue(revenue);

        uint256 releasableA = revenueLock.releasable(beneficiaryA);
        assertLe(releasableA, ALLOC_A, "releasable exceeds allocation");

        if (releasableA > 0) {
            vm.prank(beneficiaryA);
            revenueLock.release(delegateeX);
            assertLe(revenueLock.released(beneficiaryA), ALLOC_A, "released exceeds allocation");
        }
    }

    function testFuzz_unlockPercentage_stepFunction(uint256 revenue) public {
        revenue = bound(revenue, 0, 10_000_000e18);
        revenueCounter.setRevenue(revenue);
        uint256 pct = revenueLock.unlockPercentage();

        // Must be one of the valid step values
        assertTrue(
            pct == 0 || pct == 1000 || pct == 2500 || pct == 4000 ||
            pct == 6000 || pct == 8000 || pct == 10000,
            "unlock percentage not a valid step value"
        );
    }

    // ============ Ratchet Tests ============
    //
    // These tests target the monotonic ratchet and rate-limit that neutralise
    // governance-controlled RevenueCounter upgrades. They MUST use raw setRevenue
    // (not _setRevenueAndBudget) so that the rate-limit boundary is actually
    // exercised instead of being hidden by the helper's auto-warp.

    event ObservedRevenueUpdated(uint256 oldMax, uint256 newMax, uint256 reportedByCounter);

    /// @dev WHY: the spec's defining property — if RevenueCounter is upgraded to
    ///      return a value LOWER than the previously observed high-water mark,
    ///      the ratchet must hold. Otherwise an attacker can freeze beneficiaries
    ///      mid-release by forcing `entitled < alreadyReleased`.
    function test_ratchet_rewindIsIgnored() public {
        // Warp a day, counter reports $10k, ratchet advances to $10k.
        vm.warp(block.timestamp + 1 days);
        revenueCounter.setRevenue(10_000e18);
        revenueLock.syncObservedRevenue();
        assertEq(revenueLock.maxObservedRevenue(), 10_000e18, "ratchet should be at 10k");

        // Simulate a malicious upgrade that reports 0.
        revenueCounter.setRevenue(0);

        // Another day passes — the ratchet must not move backward.
        vm.warp(block.timestamp + 1 days);
        revenueLock.syncObservedRevenue();
        assertEq(revenueLock.maxObservedRevenue(), 10_000e18, "ratchet must not rewind");

        // And views (which flow through the ratchet) remain stable.
        assertEq(revenueLock.unlockPercentage(), 1000, "unlockPercentage must not rewind");
    }

    /// @dev WHY: the acceleration attack from issue #225 — a malicious upgrade
    ///      reports type(uint256).max trying to flip every milestone at once.
    ///      The ratchet must cap the advance to `elapsed * maxIncrease / 1 day`,
    ///      not to whatever the counter reports.
    function test_ratchet_capsInstantAcceleration() public {
        // Attacker reports astronomical revenue.
        revenueCounter.setRevenue(type(uint256).max);

        // Only 1 day has passed since deployment.
        vm.warp(block.timestamp + 1 days);
        revenueLock.syncObservedRevenue();

        // Ratchet may only advance by MAX_INCREASE_PER_DAY.
        assertEq(revenueLock.maxObservedRevenue(), MAX_INCREASE_PER_DAY, "advance must be rate-capped");

        // Even with the counter still at max, unlockPercentage only reflects what the
        // capped ratchet allows. $10k → 10% (first milestone), NOT 100%.
        assertEq(revenueLock.unlockPercentage(), 1000, "step must reflect capped value");
    }

    /// @dev WHY: the issue #225 auditor checklist calls this out explicitly —
    ///      lastSyncTimestamp must advance on EVERY call, even when the ratchet
    ///      itself does not move. Otherwise a daily no-op sync during a flat-
    ///      revenue period fails to consume the elapsed-time allowance and the
    ///      rate cap becomes meaningless over long idle windows.
    function test_ratchet_lastSyncTimestampAdvancesOnNoOp() public {
        // No revenue, no elapsed time, nothing to advance.
        uint256 tsBefore = revenueLock.lastSyncTimestamp();

        // Warp forward and sync with the counter still at 0.
        vm.warp(block.timestamp + 1 days);
        revenueLock.syncObservedRevenue();

        // Ratchet did NOT advance (nothing to advance to).
        assertEq(revenueLock.maxObservedRevenue(), 0, "no-op sync must not advance ratchet");
        // But lastSyncTimestamp DID advance. This is the critical property.
        assertGt(revenueLock.lastSyncTimestamp(), tsBefore, "no-op sync must still advance timestamp");
        assertEq(revenueLock.lastSyncTimestamp(), block.timestamp, "timestamp must be now");
    }

    /// @dev WHY: without unconditional timestamp advancement, an attacker could
    ///      accumulate budget over a long idle period (no sync, no release) and
    ///      then burn it all in a single transaction after a malicious upgrade,
    ///      defeating the purpose of the rate cap. This test proves budget DOES
    ///      accumulate proportionally to elapsed time — forming the basis of the
    ///      "call syncObservedRevenue() regularly" operational requirement.
    function test_ratchet_budgetAccumulatesOverIdlePeriod() public {
        // 10 days pass with no sync.
        vm.warp(block.timestamp + 10 days);

        // Counter jumps to a huge value.
        revenueCounter.setRevenue(type(uint256).max);

        // A single sync: budget = 10 * MAX_INCREASE_PER_DAY, ratchet advances by that much.
        revenueLock.syncObservedRevenue();
        assertEq(revenueLock.maxObservedRevenue(), 10 * MAX_INCREASE_PER_DAY,
            "budget accumulates over idle days - exactly why regular syncs are required");
    }

    /// @dev WHY: ratchet must cap to `reported` when the counter is the smaller
    ///      value, and to `prev + budget` when the counter is larger. Both sides
    ///      of min() must be exercised.
    function test_ratchet_capsToReportedWhenReportedIsSmaller() public {
        revenueCounter.setRevenue(1_500e18);
        vm.warp(block.timestamp + 1 days);
        revenueLock.syncObservedRevenue();
        // Reported ($1.5k) < budget ($10k) → ratchet caps to reported.
        assertEq(revenueLock.maxObservedRevenue(), 1_500e18, "must cap to reported when smaller");
    }

    /// @dev WHY: getCappedObservedRevenue is the off-chain monitoring primitive.
    ///      It must return the EXACT value that a simultaneous syncObservedRevenue
    ///      would produce, otherwise bots cannot trust it. Mirrors the auditor
    ///      checklist item "view and state-modifying return consistent values".
    function test_view_getCappedObservedRevenue_matchesSync() public {
        vm.warp(block.timestamp + 3 days);
        revenueCounter.setRevenue(50_000e18);

        uint256 predicted = revenueLock.getCappedObservedRevenue();
        revenueLock.syncObservedRevenue();
        assertEq(revenueLock.maxObservedRevenue(), predicted, "view must match actual sync");
    }

    /// @dev WHY: permissionless access is a hard requirement from the spec —
    ///      monitoring bots need to advance the ratchet without holding special
    ///      privileges. Any address must be able to call it.
    function test_syncObservedRevenue_isPermissionless() public {
        vm.warp(block.timestamp + 1 days);
        revenueCounter.setRevenue(5_000e18);

        // nonBeneficiary has no role, but can still sync.
        vm.prank(nonBeneficiary);
        revenueLock.syncObservedRevenue();

        assertEq(revenueLock.maxObservedRevenue(), 5_000e18, "anyone must be able to sync");
    }

    /// @dev WHY: the ObservedRevenueUpdated event is the monitoring infrastructure's
    ///      only on-chain signal for "ratchet advance happened". Its payload must
    ///      include the oldMax, newMax, and (critically) the raw reported value so
    ///      off-chain tools can distinguish a clean advance from a rate-limited one.
    function test_ratchet_emitsObservedRevenueUpdated() public {
        vm.warp(block.timestamp + 1 days);
        revenueCounter.setRevenue(type(uint256).max);

        vm.expectEmit(false, false, false, true);
        emit ObservedRevenueUpdated(0, MAX_INCREASE_PER_DAY, type(uint256).max);
        revenueLock.syncObservedRevenue();
    }

    /// @dev WHY: converse to the event test — the event must NOT fire on a no-op
    ///      sync. Otherwise monitoring would be flooded with non-events and real
    ///      advances would be harder to spot. `ObservedRevenueUpdated` is reserved
    ///      for *actual* state changes of maxObservedRevenue.
    function test_ratchet_noEventOnNoOpSync() public {
        vm.recordLogs();
        revenueLock.syncObservedRevenue();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "no-op sync must not emit ObservedRevenueUpdated");
    }

    /// @dev WHY: the primary bug from issue #225 — `release()` previously computed
    ///      `entitled - alreadyReleased`. A malicious downgrade of RevenueCounter
    ///      could push `entitled` below `alreadyReleased`, causing 0.8.x safe-math
    ///      underflow and freezing the beneficiary. With the ratchet, `entitled`
    ///      is computed from maxObservedRevenue which only grows, so this class
    ///      of freeze is structurally impossible.
    function test_ratchet_releaseDoesNotUnderflowOnCounterRewind() public {
        // First release at the $10k milestone.
        _setRevenueAndBudget(10_000e18);
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        uint256 releasedBefore = revenueLock.released(beneficiaryA);
        assertGt(releasedBefore, 0, "setup: first release should have succeeded");

        // Attacker downgrades the counter to 0.
        revenueCounter.setRevenue(0);

        // A subsequent release should simply revert with "nothing to release" — NOT
        // underflow — because the ratchet still sees $10k. Beneficiaries remain
        // whole; they just have nothing new to claim until real revenue grows.
        vm.prank(beneficiaryA);
        vm.expectRevert("RevenueLock: nothing to release");
        revenueLock.release(delegateeX);

        // And `released` is unchanged.
        assertEq(revenueLock.released(beneficiaryA), releasedBefore, "released must not change");
    }

    /// @dev WHY: releasable() and unlockPercentage() are views driving UIs and
    ///      integrations. They must preview the effect of a hypothetical release
    ///      (which would call _updateMaxObservedRevenue first), not read stale
    ///      storage. Concretely: after the counter reports a new milestone but
    ///      before anyone syncs, the views should already reflect what release
    ///      would deliver.
    function test_views_previewPostSyncState() public {
        // Stage: counter reports $10k, one day has passed, but no sync yet.
        vm.warp(block.timestamp + 1 days);
        revenueCounter.setRevenue(10_000e18);

        // Storage is still 0.
        assertEq(revenueLock.maxObservedRevenue(), 0, "storage not yet advanced");

        // But views reflect what a release would see: 10% unlock, allocation * 10%.
        assertEq(revenueLock.unlockPercentage(), 1000, "unlockPercentage must preview");
        assertEq(revenueLock.releasable(beneficiaryA), ALLOC_A * 1000 / 10000,
            "releasable must preview");
    }
}

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
        new RevenueLock(address(0), address(revenueCounter), b, a);
    }

    function test_constructor_zeroRevenueCounter_reverts() public {
        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: zero revenueCounter");
        new RevenueLock(address(armToken), address(0), b, a);
    }

    function test_constructor_emptyBeneficiaries_reverts() public {
        address[] memory b = new address[](0);
        uint256[] memory a = new uint256[](0);

        vm.expectRevert("RevenueLock: empty beneficiaries");
        new RevenueLock(address(armToken), address(revenueCounter), b, a);
    }

    function test_constructor_lengthMismatch_reverts() public {
        address[] memory b = new address[](2);
        b[0] = beneficiaryA;
        b[1] = beneficiaryB;
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: length mismatch");
        new RevenueLock(address(armToken), address(revenueCounter), b, a);
    }

    function test_constructor_zeroBeneficiaryAddress_reverts() public {
        address[] memory b = new address[](1);
        b[0] = address(0);
        uint256[] memory a = new uint256[](1);
        a[0] = 1e18;

        vm.expectRevert("RevenueLock: zero beneficiary");
        new RevenueLock(address(armToken), address(revenueCounter), b, a);
    }

    function test_constructor_zeroAmount_reverts() public {
        address[] memory b = new address[](1);
        b[0] = beneficiaryA;
        uint256[] memory a = new uint256[](1);
        a[0] = 0;

        vm.expectRevert("RevenueLock: zero amount");
        new RevenueLock(address(armToken), address(revenueCounter), b, a);
    }

    function test_constructor_duplicateBeneficiary_reverts() public {
        address[] memory b = new address[](2);
        b[0] = beneficiaryA;
        b[1] = beneficiaryA;
        uint256[] memory a = new uint256[](2);
        a[0] = 1e18;
        a[1] = 1e18;

        vm.expectRevert("RevenueLock: duplicate beneficiary");
        new RevenueLock(address(armToken), address(revenueCounter), b, a);
    }

    // ============ View Function Tests ============

    function test_allocation_unknownAddress_returnsZero() public {
        assertEq(revenueLock.allocation(nonBeneficiary), 0);
    }

    function test_unlockPercentage_zeroRevenue() public {
        assertEq(revenueLock.unlockPercentage(), 0);
    }

    function test_unlockPercentage_belowFirstMilestone() public {
        revenueCounter.setRevenue(9_999e18);
        assertEq(revenueLock.unlockPercentage(), 0);
    }

    function test_unlockPercentage_atFirstMilestone() public {
        revenueCounter.setRevenue(10_000e18);
        assertEq(revenueLock.unlockPercentage(), 1000); // 10%
    }

    function test_unlockPercentage_betweenMilestones() public {
        revenueCounter.setRevenue(49_999e18);
        assertEq(revenueLock.unlockPercentage(), 1000); // still 10%, step function
    }

    function test_unlockPercentage_atSecondMilestone() public {
        revenueCounter.setRevenue(50_000e18);
        assertEq(revenueLock.unlockPercentage(), 2500); // 25%
    }

    function test_unlockPercentage_atThirdMilestone() public {
        revenueCounter.setRevenue(100_000e18);
        assertEq(revenueLock.unlockPercentage(), 4000); // 40%
    }

    function test_unlockPercentage_atFourthMilestone() public {
        revenueCounter.setRevenue(250_000e18);
        assertEq(revenueLock.unlockPercentage(), 6000); // 60%
    }

    function test_unlockPercentage_atFifthMilestone() public {
        revenueCounter.setRevenue(500_000e18);
        assertEq(revenueLock.unlockPercentage(), 8000); // 80%
    }

    function test_unlockPercentage_atSixthMilestone() public {
        revenueCounter.setRevenue(1_000_000e18);
        assertEq(revenueLock.unlockPercentage(), 10000); // 100%
    }

    function test_unlockPercentage_aboveMaxMilestone() public {
        revenueCounter.setRevenue(5_000_000e18);
        assertEq(revenueLock.unlockPercentage(), 10000); // still 100%
    }

    function test_currentRevenue_readsCounter() public {
        revenueCounter.setRevenue(42e18);
        assertEq(revenueLock.currentRevenue(), 42e18);
    }

    function test_releasable_zeroRevenue() public {
        assertEq(revenueLock.releasable(beneficiaryA), 0);
    }

    function test_releasable_nonBeneficiary() public {
        revenueCounter.setRevenue(1_000_000e18);
        assertEq(revenueLock.releasable(nonBeneficiary), 0);
    }

    function test_releasable_atFirstMilestone() public {
        revenueCounter.setRevenue(10_000e18);
        // 10% of ALLOC_A = 120,000 ARM
        assertEq(revenueLock.releasable(beneficiaryA), ALLOC_A * 1000 / 10000);
    }

    // ============ Release Tests ============

    function test_release_nonBeneficiary_reverts() public {
        revenueCounter.setRevenue(10_000e18);
        vm.prank(nonBeneficiary);
        vm.expectRevert("RevenueLock: not a beneficiary");
        revenueLock.release(delegateeX);
    }

    function test_release_zeroDelegatee_reverts() public {
        revenueCounter.setRevenue(10_000e18);
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
        revenueCounter.setRevenue(10_000e18);

        uint256 expected = ALLOC_A * 1000 / 10000; // 10%
        uint256 balBefore = armToken.balanceOf(beneficiaryA);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        assertEq(armToken.balanceOf(beneficiaryA), balBefore + expected);
        assertEq(revenueLock.released(beneficiaryA), expected);
    }

    function test_release_delegatesToSpecifiedAddress() public {
        revenueCounter.setRevenue(10_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        assertEq(armToken.delegates(beneficiaryA), delegateeX);
    }

    function test_release_secondCallAtSameMilestone_reverts() public {
        revenueCounter.setRevenue(10_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        vm.prank(beneficiaryA);
        vm.expectRevert("RevenueLock: nothing to release");
        revenueLock.release(delegateeX);
    }

    function test_release_atSecondMilestone_transfersDelta() public {
        // First release at 10%
        revenueCounter.setRevenue(10_000e18);
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        uint256 firstRelease = ALLOC_A * 1000 / 10000;

        // Revenue increases to $50k (25%)
        revenueCounter.setRevenue(50_000e18);
        uint256 balBefore = armToken.balanceOf(beneficiaryA);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        uint256 secondRelease = (ALLOC_A * 2500 / 10000) - firstRelease;
        assertEq(armToken.balanceOf(beneficiaryA), balBefore + secondRelease);
        assertEq(revenueLock.released(beneficiaryA), firstRelease + secondRelease);
    }

    function test_release_atFullUnlock_transfersEverything() public {
        revenueCounter.setRevenue(1_000_000e18);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);

        assertEq(revenueLock.released(beneficiaryA), ALLOC_A);
        assertEq(armToken.balanceOf(beneficiaryA), ALLOC_A);
        assertEq(revenueLock.releasable(beneficiaryA), 0);
    }

    function test_release_emitsEvent() public {
        revenueCounter.setRevenue(10_000e18);
        uint256 expectedAmount = ALLOC_A * 1000 / 10000;

        vm.expectEmit(true, false, false, true);
        emit Released(beneficiaryA, expectedAmount, delegateeX, expectedAmount);

        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
    }

    function test_release_multipleBeneficiariesIndependent() public {
        revenueCounter.setRevenue(100_000e18); // 40% unlock

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
        revenueCounter.setRevenue(10_000e18);

        // First release: delegate to X
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeX);
        assertEq(armToken.delegates(beneficiaryA), delegateeX);

        // Increase revenue, release again with different delegatee
        revenueCounter.setRevenue(50_000e18);
        vm.prank(beneficiaryA);
        revenueLock.release(delegateeY);
        assertEq(armToken.delegates(beneficiaryA), delegateeY);
    }

    function test_release_selfDelegation() public {
        revenueCounter.setRevenue(10_000e18);

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
            revenueCounter.setRevenue(thresholds[i]);
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
        revenueCounter.setRevenue(250_000e18); // 60%

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
}

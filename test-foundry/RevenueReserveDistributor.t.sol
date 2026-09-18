// SPDX-License-Identifier: MIT
// ABOUTME: Reserve distributor integration tests using real ARM, RevenueLock, RevenueCounter, wind-down and redemption.
// ABOUTME: Covers batch gas, claim liveness, immutable assignments, delegation and wind-down conservation.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/RevenueReserveDistributor.sol";
import "../contracts/governance/RevenueLock.sol";
import "../contracts/governance/RevenueCounter.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaWindDown.sol";
import "../contracts/governance/ArmadaRedemption.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Only governor/pause shutdown callbacks are stubbed; no governance proposals are exercised.
contract ReserveShutdownReceiver {
    bool public windDownActive;

    function setWindDownActive() external {
        windDownActive = true;
    }
}

/// @dev Models a fully settled crowdfund with no remaining participant entitlement.
contract ReserveSettledCrowdfund {
    function armStillOwed() external pure returns (uint256) {
        return 0;
    }
}

contract ReserveTestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Rejecting fallback must not interfere with ordinary ERC20 transfers to this account.
contract ReserveRejectingRecipient {
    fallback() external payable {
        revert("no callbacks");
    }
}

abstract contract RevenueReserveDistributorFixture is Test {
    uint256 internal constant RESERVE = 360_000e18;
    uint256 internal constant DIRECT = 2_040_000e18;
    uint256 internal constant LOCK_TOTAL = RESERVE + DIRECT;
    uint256 internal constant RATE = 10_000e18;

    ArmadaToken internal token;
    RevenueCounter internal counter;
    RevenueLock internal lock;
    RevenueReserveDistributor internal distributor;
    ArmadaWindDown internal windDown;
    ArmadaRedemption internal redemption;
    ReserveTestUSDC internal usdc;
    address internal allocator = address(0xA110C);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal direct = address(0xD1EC7);
    address internal treasury = address(0x7EA5);
    address internal outsider = address(0xCA11E2);

    function setUp() public virtual {
        token = new ArmadaToken(address(this), address(this));
        RevenueCounter implementation = new RevenueCounter();
        counter = RevenueCounter(
            address(
                new ERC1967Proxy(address(implementation), abi.encodeCall(RevenueCounter.initialize, (address(this))))
            )
        );
        distributor = new RevenueReserveDistributor(address(token), allocator, RESERVE);
        address[] memory recipients = new address[](2);
        recipients[0] = address(distributor);
        recipients[1] = direct;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE;
        amounts[1] = DIRECT;
        lock = new RevenueLock(address(token), address(counter), RATE, recipients, amounts);
        distributor.bindRevenueLock(address(lock));

        ReserveSettledCrowdfund crowdfund = new ReserveSettledCrowdfund();
        redemption = new ArmadaRedemption(address(token), treasury, address(lock), address(crowdfund));
        ReserveShutdownReceiver shutdown = new ReserveShutdownReceiver();
        windDown = new ArmadaWindDown(
            address(token),
            treasury,
            address(shutdown),
            address(redemption),
            address(shutdown),
            address(counter),
            address(lock),
            address(this),
            10_000e18,
            block.timestamp + 365 days
        );
        lock.setWindDownContract(address(windDown));
        counter.setWindDownContract(address(windDown));
        token.setWindDownContract(address(windDown));
        redemption.setWindDown(address(windDown));

        address[] memory whitelist = new address[](3);
        whitelist[0] = address(this);
        whitelist[1] = address(lock);
        whitelist[2] = address(distributor);
        token.initWhitelist(whitelist);
        address[] memory delegators = new address[](1);
        delegators[0] = address(lock);
        token.initAuthorizedDelegators(delegators);
        address[] memory noDelegation = new address[](1);
        noDelegation[0] = treasury;
        token.initNoDelegation(noDelegation);

        token.transfer(address(lock), LOCK_TOTAL);
        token.transfer(treasury, token.balanceOf(address(this)));
        lock.activate();
        usdc = new ReserveTestUSDC();
        vm.roll(block.number + 1);
    }

    function _assign(address who, uint256 amount) internal {
        // Signature/threshold enforcement belongs to the allocator's external multisig.
        vm.prank(allocator);
        distributor.assign(who, amount);
    }

    function _revenue(uint256 value) internal {
        counter.attestRevenue(value);
        uint256 observed = lock.maxObservedRevenue();
        if (value > observed) vm.warp(block.timestamp + ((value - observed) / RATE + 1) * 1 days);
        vm.roll(block.number + 1);
    }

    function _failCounter() internal {
        vm.mockCallRevert(address(counter), abi.encodeWithSignature("recognizedRevenueUsd()"), "counter unavailable");
    }
}

contract RevenueReserveDistributorTest is RevenueReserveDistributorFixture {
    // WHY: One sponsor must pay all grantees without their signatures or delegation authority.
    function test_claimPaysEveryoneWithoutPayingCaller() public {
        _assign(alice, 3_000e18);
        _assign(bob, 9_000e18);
        _revenue(10_000e18);
        vm.prank(outsider);
        assertEq(distributor.claim(), 1_200e18);
        assertEq(token.balanceOf(alice), 300e18);
        assertEq(token.balanceOf(bob), 900e18);
        assertEq(token.balanceOf(outsider), 0);
        assertEq(token.balanceOf(allocator), 0);
        assertEq(distributor.totalCollected(), 36_000e18);
        assertEq(distributor.collectedBps(), 1000);
        assertFalse(token.transferable());
        assertFalse(token.authorizedDelegator(address(distributor)));
    }

    // WHY: Duplicate batches and overlapping ranges cannot double-pay or waste capacity.
    function test_repeatAndOverlappingClaimsAreNoops() public {
        _assign(alice, 3_000e18);
        _assign(bob, 9_000e18);
        _revenue(10_000e18);
        distributor.collect();
        assertEq(distributor.claimRange(1, 2), 300e18);
        assertEq(distributor.claimRange(0, 3), 900e18);
        assertEq(distributor.claimRange(3, 3), 0);
        assertEq(distributor.claim(), 0);
        assertEq(distributor.claimCollected(), 0);
        vm.prank(alice);
        assertEq(distributor.claimSelf(), 0);
        assertEq(distributor.totalClaimed(), 1_200e18);
        assertEq(distributor.totalAssigned(), 12_000e18);
    }

    // WHY: Later grants and top-ups inherit completed milestones without resetting prior payments.
    function test_topUpsAndLateGrantsInheritMilestones() public {
        _assign(alice, 3_000e18);
        _revenue(50_000e18);
        distributor.claim();
        _assign(alice, 1_000e18);
        _assign(bob, 2_000e18);
        assertEq(distributor.claimable(alice), 250e18);
        assertEq(distributor.claimable(bob), 500e18);
        distributor.claimCollected();
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(token.balanceOf(bob), 500e18);
        assertEq(distributor.beneficiaryCount(), 3);
        _revenue(100_000e18);
        distributor.claim();
        assertEq(token.balanceOf(alice), 1_600e18);
        assertEq(token.balanceOf(bob), 800e18);
    }

    // WHY: Assignment authority must be both address-gated and bounded by lifetime allocations.
    function test_assignmentGuardsAndCapacityNeverRecycle() public {
        vm.expectRevert(RevenueReserveDistributor.NotAllocator.selector);
        distributor.assign(alice, 1e18);
        _assign(alice, RESERVE);
        _revenue(1_000_000e18);
        distributor.claim();
        vm.prank(allocator);
        vm.expectRevert(RevenueReserveDistributor.ReserveExceeded.selector);
        distributor.assign(bob, 1e18);
        assertEq(distributor.remainingAssignable(), 0);
        assertEq(token.balanceOf(alice), RESERVE);
    }

    // WHY: Invalid destinations strand grants; sub-quantum grants undermine exact split accounting.
    function test_invalidAssignmentsAndRangesRevert() public {
        address[4] memory bad = [address(0), address(distributor), address(lock), address(token)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(allocator);
            vm.expectRevert(RevenueReserveDistributor.InvalidAddress.selector);
            distributor.assign(bad[i], 1e18);
        }
        vm.startPrank(allocator);
        vm.expectRevert(RevenueReserveDistributor.InvalidAmount.selector);
        distributor.assign(alice, 0);
        vm.expectRevert(RevenueReserveDistributor.InvalidAmount.selector);
        distributor.assign(alice, 1);
        vm.stopPrank();
        vm.expectRevert(RevenueReserveDistributor.InvalidRange.selector);
        distributor.claimRange(1, 0);
        vm.expectRevert(RevenueReserveDistributor.InvalidRange.selector);
        distributor.claimRange(0, 2);
    }

    // WHY: A full list must remain bounded while top-ups and the allocator fallback still work.
    function test_recipientLimitReservesAllocatorSlot() public {
        for (uint256 i; i < 50; ++i) {
            _assign(address(uint160(0x1000 + i)), 1e18);
        }
        assertEq(distributor.beneficiaryCount(), 51);
        assertEq(distributor.beneficiaries(0), allocator);
        vm.prank(allocator);
        vm.expectRevert(RevenueReserveDistributor.TooManyBeneficiaries.selector);
        distributor.assign(alice, 1e18);
        _assign(address(0x1000), 2e18);
        _assign(allocator, 1e18);
        assertEq(distributor.beneficiaryCount(), 51);
        _revenue(10_000e18);
        windDown.governanceTriggerWindDown();
        distributor.claim();
        assertEq(distributor.totalClaimed(), RESERVE / 10);
    }

    // WHY: No claim path may grant voting power over the entire held reserve to its sponsor.
    function test_collectionUndelegatesAndPreservesRecipientDelegation() public {
        _assign(alice, 3_000e18);
        _assign(bob, 3_000e18);
        vm.prank(alice);
        token.delegate(outsider);
        _revenue(10_000e18);
        distributor.claim();
        assertEq(token.delegates(address(distributor)), address(0));
        assertEq(token.getVotes(address(distributor)), 0);
        assertEq(token.getVotes(allocator), 0);
        assertEq(token.getVotes(outsider), 300e18);
        assertEq(token.delegates(alice), outsider);
        assertEq(token.delegates(bob), address(0));
        vm.roll(block.number + 1);
        assertEq(token.getPastVotes(address(distributor), block.number - 1), 0);
    }

    // WHY: ERC20 payouts do not call recipients, even when a recipient reverts on every call.
    function test_rejectingRecipientCannotBlockBatch() public {
        ReserveRejectingRecipient rejecting = new ReserveRejectingRecipient();
        _assign(address(rejecting), 3_000e18);
        _assign(alice, 3_000e18);
        _revenue(10_000e18);
        distributor.claim();
        assertEq(token.balanceOf(address(rejecting)), 300e18);
        assertEq(token.balanceOf(alice), 300e18);
    }

    // WHY: A bad upstream upgrade must not prevent distribution of ARM already collected.
    function test_counterFailureLeavesCollectedBatchRangeAndSelfClaimsLive() public {
        _assign(alice, 3_000e18);
        _assign(bob, 9_000e18);
        _revenue(10_000e18);
        distributor.collect();
        _failCounter();
        vm.expectRevert();
        distributor.claim();
        assertEq(distributor.claimable(alice), 300e18);
        vm.prank(alice);
        assertEq(distributor.claimSelf(), 300e18);
        assertEq(distributor.claimRange(2, 3), 900e18);
        _assign(bob, 1_000e18);
        assertEq(distributor.claimCollected(), 100e18);
    }

    // WHY: Once fully collected, even the default collect-and-pay path must not consult the counter.
    function test_fullCollectionRemovesCounterDependency() public {
        _revenue(1_000_000e18);
        distributor.collect();
        _failCounter();
        _assign(alice, 3_000e18);
        assertEq(distributor.collect(), 0);
        assertEq(distributor.claim(), 3_000e18);
    }

    // WHY: Donated ARM must neither inflate entitlement nor restore spent assignment capacity.
    function test_donationsDoNotUnlockOrIncreaseCapacity() public {
        token.setTransferable(true);
        vm.prank(treasury);
        token.transfer(address(distributor), 1_000e18);
        _assign(alice, 3_000e18);
        distributor.claim();
        assertEq(distributor.collectedBps(), 0);
        assertEq(distributor.claimable(alice), 0);
        assertEq(distributor.totalClaimed(), 0);
        assertEq(distributor.remainingAssignable(), RESERVE - 3_000e18);
        _revenue(1_000_000e18);
        windDown.governanceTriggerWindDown();
        distributor.claim();
        assertEq(token.balanceOf(address(distributor)), 1_000e18);
        assertEq(distributor.totalClaimed(), RESERVE);
    }

    // WHY: A reverted transfer must roll back every payment/collection; a smaller range remains available.
    function test_failedTransferIsAtomicAndRangeCanIsolateIt() public {
        _assign(alice, 3_000e18);
        _assign(bob, 9_000e18);
        _revenue(10_000e18);
        vm.mockCallRevert(address(token), abi.encodeCall(IERC20.transfer, (bob, 900e18)), "blocked in test");
        vm.expectRevert();
        distributor.claim();
        assertEq(token.balanceOf(alice), 0);
        assertEq(distributor.claimed(alice), 0);
        assertEq(distributor.totalCollected(), 0);
        assertEq(lock.released(address(distributor)), 0);
        distributor.collect();
        assertEq(distributor.claimRange(1, 2), 300e18);
        vm.clearMockedCalls();
        assertEq(distributor.claimCollected(), 900e18);
    }

    // WHY: Clearing the temporary delegation is required, not a best-effort operation.
    function test_undelegationFailureRevertsEntireCollection() public {
        _revenue(10_000e18);
        vm.mockCallRevert(address(token), abi.encodeWithSignature("delegate(address)", address(0)), "failed delegate");
        vm.expectRevert();
        distributor.collect();
        assertEq(distributor.totalCollected(), 0);
        assertEq(lock.released(address(distributor)), 0);
        assertEq(token.balanceOf(address(distributor)), 0);
    }

    // WHY: Wind-down closes assignment without a finalizer and preserves both past claims and fallback.
    function test_windDownFallbackAfterAllocatorAndRecipientClaims() public {
        _assign(alice, 100_000e18);
        _assign(allocator, 20_000e18);
        _revenue(10_000e18);
        distributor.claim();
        assertEq(token.balanceOf(allocator), 2_000e18);
        _revenue(100_000e18);
        windDown.governanceTriggerWindDown();
        assertEq(distributor.remainingAssignable(), 0);
        assertEq(distributor.effectiveAllocation(allocator), 260_000e18);
        vm.prank(allocator);
        vm.expectRevert(RevenueReserveDistributor.AssignmentsClosed.selector);
        distributor.assign(bob, 1e18);
        distributor.claim();
        assertEq(token.balanceOf(alice), 40_000e18);
        assertEq(token.balanceOf(allocator), 104_000e18);
        assertEq(distributor.totalClaimed(), 144_000e18);
        assertEq(distributor.totalAssigned(), 120_000e18);
        assertEq(lock.lockedAtWindDown(), LOCK_TOTAL * 6000 / 10_000);
        assertEq(distributor.claim(), 0);
    }

    // WHY: freezeAtWindDown performs a final ratchet update which may cross a previously uncollected tier.
    function test_windDownFinalUpdateCrossesMilestoneAndCounterCanThenFail() public {
        _assign(alice, 3_000e18);
        _revenue(9_000e18);
        lock.syncObservedRevenue();
        assertEq(distributor.collectedBps(), 0);
        counter.attestRevenue(10_000e18);
        vm.warp(block.timestamp + 1 days);
        windDown.governanceTriggerWindDown();
        _failCounter();
        distributor.claim();
        assertEq(distributor.collectedBps(), 1000);
        assertEq(token.balanceOf(alice), 300e18);
        assertEq(token.balanceOf(allocator), (RESERVE - 3_000e18) / 10);
    }

    // WHY: A zero-unlock wind-down transfers entitlement but must not create spendable tokens.
    function test_permissionlessZeroRevenueWindDownPaysNothing() public {
        vm.warp(windDown.windDownDeadline() + 1);
        vm.prank(outsider);
        windDown.triggerWindDown();
        assertEq(distributor.effectiveAllocation(allocator), RESERVE);
        assertEq(distributor.claim(), 0);
        assertEq(token.balanceOf(allocator), 0);
    }

    // WHY: A fully allocated reserve leaves no extra fallback; 100% unlock pays every token exactly once.
    function test_fullyAssignedWindDownHasNoFallback() public {
        _assign(alice, RESERVE);
        _revenue(1_000_000e18);
        windDown.governanceTriggerWindDown();
        distributor.claim();
        assertEq(distributor.effectiveAllocation(allocator), 0);
        assertEq(token.balanceOf(alice), RESERVE);
        assertEq(token.balanceOf(address(distributor)), 0);
    }

    // WHY: The wrapper must inherit the rate cap rather than treating reported revenue as unlocked revenue.
    function test_collectionRespectsOriginalRateLimit() public {
        _assign(alice, 3_000e18);
        counter.attestRevenue(1_000_000e18);
        vm.warp(block.timestamp + 1 days);
        distributor.claim();
        assertEq(lock.maxObservedRevenue(), 10_000e18);
        assertEq(distributor.collectedBps(), 1000);
        assertEq(token.balanceOf(alice), 300e18);
    }

    // WHY: A reserve beneficiary must have the same payout regardless of whether direct holders redeem first.
    function test_redemptionDirectHolderFirst() public {
        _redemptionOrder(true);
    }

    // WHY: Claiming and redeeming the fallback first must not dilute unreleased direct entitlements.
    function test_redemptionReserveHoldersFirst() public {
        _redemptionOrder(false);
    }

    function _redemptionOrder(bool directFirst) internal {
        _assign(alice, 100_000e18);
        _assign(bob, 80_000e18);
        _revenue(100_000e18);
        windDown.governanceTriggerWindDown();
        vm.warp(block.timestamp + 7 days + 1);
        uint256 circulating = LOCK_TOTAL * 4000 / 10_000;
        assertEq(redemption.circulatingSupply(), circulating);
        usdc.mint(address(redemption), circulating / 1e12);
        if (directFirst) _redeemDirect();
        uint256 beforeClaims = redemption.circulatingSupply();
        distributor.claim();
        assertEq(redemption.circulatingSupply(), beforeClaims);
        _redeem(alice);
        _redeem(bob);
        _redeem(allocator);
        if (!directFirst) _redeemDirect();
        assertEq(usdc.balanceOf(alice), 40_000e6);
        assertEq(usdc.balanceOf(bob), 32_000e6);
        assertEq(usdc.balanceOf(allocator), 72_000e6);
        assertEq(usdc.balanceOf(direct), 816_000e6);
        assertEq(usdc.balanceOf(address(redemption)), 0);
        assertEq(redemption.circulatingSupply(), 0);
    }

    function _redeemDirect() internal {
        vm.prank(direct);
        lock.release(direct);
        _redeem(direct);
    }

    function _redeem(address who) internal {
        address[] memory assets = new address[](1);
        assets[0] = address(usdc);
        uint256 amount = token.balanceOf(who);
        vm.startPrank(who);
        token.approve(address(redemption), amount);
        redemption.redeem(amount, assets, address(0));
        vm.stopPrank();
    }

    // WHY: Bootstrap has a one-shot trust boundary; no attacker or second bind may replace the lock.
    function test_bindingAuthorityAndConsistency() public {
        RevenueReserveDistributor fresh = new RevenueReserveDistributor(address(token), allocator, RESERVE);
        vm.prank(outsider);
        vm.expectRevert(RevenueReserveDistributor.NotDeployer.selector);
        fresh.bindRevenueLock(address(lock));
        vm.expectRevert(RevenueReserveDistributor.InvalidLock.selector);
        fresh.bindRevenueLock(address(lock)); // lock allocates to the original instance, not fresh
        vm.expectRevert(RevenueReserveDistributor.AlreadyBound.selector);
        distributor.bindRevenueLock(address(lock));
        vm.expectRevert(RevenueReserveDistributor.NotBound.selector);
        fresh.claim();
        vm.prank(allocator);
        vm.expectRevert(RevenueReserveDistributor.NotBound.selector);
        fresh.assign(alice, 1e18);
    }

    // WHY: Cap arithmetic and the fallback cannot be valid with zero addresses or invalid granularity.
    function test_constructorRejectsInvalidConfiguration() public {
        vm.expectRevert(RevenueReserveDistributor.InvalidAddress.selector);
        new RevenueReserveDistributor(address(0), allocator, RESERVE);
        vm.expectRevert(RevenueReserveDistributor.InvalidAddress.selector);
        new RevenueReserveDistributor(address(token), address(0), RESERVE);
        vm.expectRevert(RevenueReserveDistributor.InvalidAmount.selector);
        new RevenueReserveDistributor(address(token), allocator, 0);
        vm.expectRevert(RevenueReserveDistributor.InvalidAmount.selector);
        new RevenueReserveDistributor(address(token), allocator, RESERVE + 1);
        uint256 aboveSupply = token.totalSupply() + 10_000;
        vm.expectRevert(RevenueReserveDistributor.InvalidAmount.selector);
        new RevenueReserveDistributor(address(token), allocator, aboveSupply);
    }

    // WHY: Activation must remain the source of funding truth; an unfunded lock cannot release donated wrapper ARM.
    function test_collectionRequiresOriginalActivation() public {
        vm.mockCall(address(lock), abi.encodeWithSignature("activated()"), abi.encode(false));
        vm.expectRevert(RevenueReserveDistributor.NotActivated.selector);
        distributor.collect();
    }

    // WHY: Broad allocation splits and earlier claims must remain solvent after top-ups and allocator fallback.
    function testFuzz_topUpsClaimsAndFallbackConserveReserve(uint256 a, uint256 b, uint256 c) public {
        uint256 quantum = distributor.ALLOCATION_QUANTUM();
        uint256 units = RESERVE / quantum;
        a = bound(a, 0, units);
        b = bound(b, 0, units - a);
        c = bound(c, 0, units - a - b);
        if (a > 0) _assign(alice, a * quantum);
        if (b > 0) _assign(allocator, b * quantum);
        _revenue(50_000e18);
        distributor.claim();
        if (c > 0) _assign(alice, c * quantum);
        _revenue(250_000e18);
        windDown.governanceTriggerWindDown();
        distributor.claim();
        assertEq(distributor.totalClaimed(), RESERVE * 6000 / 10_000);
        assertEq(token.balanceOf(address(distributor)), 0);
        assertEq(token.balanceOf(alice) + token.balanceOf(allocator), distributor.totalClaimed());
        assertEq(distributor.claimable(alice), 0);
        assertEq(distributor.claimable(allocator), 0);
    }
}

contract RevenueReserveDistributorGasTest is RevenueReserveDistributorFixture {
    function setUp() public override {
        super.setUp();
        for (uint256 i; i < 50; ++i) {
            _assign(address(uint160(0x1000 + i)), 3_000e18);
        }
    }

    // WHY: The proposed one-sponsor batch must fit comfortably in an L1 transaction for all 50 grantees.
    function testGas_claim50Undelegated() public {
        _revenue(10_000e18);
        _cool();
        uint256 beforeGas = gasleft();
        distributor.claim();
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("50 grantees, initial collection and payout (execution gas)", used);
        assertLt(used, 8_000_000);
        assertEq(distributor.totalClaimed(), 15_000e18);
    }

    // WHY: Distinct delegate checkpoints plus an allocator payout are the heavier 51-recipient wind-down case.
    function testGas_claim51DelegatedAtWindDown() public {
        for (uint256 i; i < 50; ++i) {
            address who = address(uint160(0x1000 + i));
            vm.prank(who);
            token.delegate(who);
        }
        vm.prank(allocator);
        token.delegate(allocator);
        _revenue(10_000e18);
        windDown.governanceTriggerWindDown();
        vm.roll(block.number + 1);
        _cool();
        uint256 beforeGas = gasleft();
        distributor.claim();
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("50 delegated grantees + allocator fallback (execution gas)", used);
        assertLt(used, 8_000_000);
        assertEq(distributor.totalClaimed(), RESERVE / 10);
    }

    function _cool() internal {
        vm.cool(address(token));
        vm.cool(address(distributor));
        vm.cool(address(lock));
        vm.cool(address(counter));
    }
}

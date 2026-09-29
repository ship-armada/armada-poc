// SPDX-License-Identifier: MIT
// ABOUTME: Stateful reserve-distributor invariants across grants, top-ups, collections, batches and wind-down.
// ABOUTME: Uses the real integration fixture at the repository's 256 runs / 50 calls invariant depth.
pragma solidity ^0.8.17;

import "./RevenueReserveDistributor.t.sol";

contract ReserveDistributorHandler is Test {
    RevenueReserveDistributor public immutable distributor;
    RevenueLock public immutable lock;
    RevenueCounter public immutable counter;
    ArmadaWindDown public immutable windDown;
    address public immutable owner;
    address public immutable allocator;
    address[] public actors;

    constructor(
        RevenueReserveDistributor _distributor,
        RevenueLock _lock,
        RevenueCounter _counter,
        ArmadaWindDown _windDown,
        address _owner
    ) {
        distributor = _distributor;
        lock = _lock;
        counter = _counter;
        windDown = _windDown;
        owner = _owner;
        allocator = _distributor.allocator();
        actors.push(allocator);
        for (uint256 i = 1; i <= 4; ++i) {
            actors.push(address(uint160(0x8000 + i)));
        }
    }

    function assign(uint256 actor, uint256 units) external {
        if (lock.frozenAtWindDown()) return;
        uint256 quantum = distributor.ALLOCATION_QUANTUM();
        uint256 remaining = distributor.remainingAssignable() / quantum;
        if (remaining == 0) return;
        units = bound(units, 1, remaining);
        vm.prank(allocator);
        distributor.assign(actors[actor % actors.length], units * quantum);
    }

    function advance(uint256 revenue, uint256 daysElapsed) external {
        if (lock.frozenAtWindDown()) return;
        vm.prank(owner);
        counter.addRevenue(bound(revenue, 0, 100_000e18));
        vm.warp(block.timestamp + bound(daysElapsed, 0, 30) * 1 days);
        vm.roll(block.number + 1);
    }

    function collect() external {
        distributor.collect();
    }

    function claim(uint256 mode, uint256 actor) external {
        mode %= 4;
        if (mode == 0) {
            distributor.distribute();
        } else if (mode == 1) {
            distributor.claimCollected();
        } else if (mode == 2) {
            vm.prank(actors[actor % actors.length]);
            distributor.claimSelf();
        } else {
            uint256 index = actor % distributor.beneficiaryCount();
            distributor.claimRange(index, index + 1);
        }
    }

    function freeze(uint256 gate) external {
        // Keep enough pre-wind-down history for grants, top-ups and multiple tiers.
        if (gate % 4 != 0 || lock.frozenAtWindDown()) return;
        vm.prank(owner);
        windDown.governanceTriggerWindDown();
    }
}

contract RevenueReserveDistributorInvariantTest is RevenueReserveDistributorFixture {
    ReserveDistributorHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ReserveDistributorHandler(distributor, lock, counter, windDown, address(this));
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ReserveDistributorHandler.assign.selector;
        selectors[1] = ReserveDistributorHandler.advance.selector;
        selectors[2] = ReserveDistributorHandler.collect.selector;
        selectors[3] = ReserveDistributorHandler.claim.selector;
        selectors[4] = ReserveDistributorHandler.freeze.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // WHY: Neither collection nor distribution may create/loss ARM or replenish assignment capacity.
    function invariant_reserveConservationAndCap() public view {
        assertLe(distributor.totalAssigned(), RESERVE);
        assertLe(distributor.totalClaimed(), distributor.totalCollected());
        assertLe(distributor.totalCollected(), RESERVE);
        assertEq(distributor.totalCollected(), lock.released(address(distributor)));
        assertEq(token.balanceOf(address(distributor)) + distributor.totalClaimed(), distributor.totalCollected());
        assertEq(token.balanceOf(address(lock)) + distributor.totalCollected(), LOCK_TOTAL);
        assertEq(distributor.collectedBps() * (RESERVE / 10_000), distributor.totalCollected());
    }

    // WHY: Every recipient must be individually solvent; post-wind-down all collected funds must have a claimant.
    function invariant_entitlementsRemainSolvent() public view {
        uint256 grants;
        uint256 effective;
        uint256 paid;
        uint256 due;
        for (uint256 i; i < 5; ++i) {
            address actor = handler.actors(i);
            grants += distributor.assigned(actor);
            effective += distributor.effectiveAllocation(actor);
            paid += distributor.claimed(actor);
            due += distributor.claimable(actor);
            assertEq(token.balanceOf(actor), distributor.claimed(actor));
            assertLe(
                distributor.claimed(actor), distributor.effectiveAllocation(actor) * distributor.collectedBps() / 10_000
            );
        }
        assertEq(grants, distributor.totalAssigned());
        assertEq(paid, distributor.totalClaimed());
        assertLe(due, token.balanceOf(address(distributor)));
        if (lock.frozenAtWindDown()) {
            assertEq(effective, RESERVE);
            assertEq(due, token.balanceOf(address(distributor)));
            assertEq(distributor.remainingAssignable(), 0);
        }
    }

    // WHY: Sponsor-triggered collection must never leave the distributor's own reserve delegated.
    function invariant_heldReserveIsUndelegated() public view {
        assertEq(token.delegates(address(distributor)), address(0));
        assertFalse(token.authorizedDelegator(address(distributor)));
    }

    // WHY: Arbitrary operation histories must still settle every unlocked token after wind-down.
    function afterInvariant() public {
        if (!lock.frozenAtWindDown()) {
            uint256 reported = counter.recognizedRevenueUsd();
            counter.attestRevenue(reported > 1_000_000e18 ? reported : 1_000_000e18);
            vm.warp(block.timestamp + 1000 days);
            windDown.governanceTriggerWindDown();
        }
        distributor.distribute();
        assertEq(token.balanceOf(address(distributor)), 0);
        assertEq(distributor.totalClaimed(), RESERVE * lock.unlockPercentage() / 10_000);
    }
}

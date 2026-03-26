// SPDX-License-Identifier: MIT
// ABOUTME: Foundry invariant tests for RevenueLock — supply conservation, no over-release, vote inertness.
// ABOUTME: Uses a stateful handler to fuzz release() calls across beneficiaries and revenue levels.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/RevenueLock.sol";
import "../contracts/governance/ArmadaToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @dev Mock RevenueCounter for invariant testing
contract MockRevenueCounterInv {
    uint256 public recognizedRevenueUsd;

    function setRevenue(uint256 _revenue) external {
        recognizedRevenueUsd = _revenue;
    }
}

/// @dev Handler contract for stateful fuzzing of RevenueLock
contract RevenueLockHandler is Test {
    RevenueLock public revenueLock;
    ArmadaToken public armToken;
    MockRevenueCounterInv public revenueCounter;
    address[] public beneficiaries;
    address[] public delegatees;

    // Ghost variables for tracking
    uint256 public ghost_releaseCount;
    uint256 public ghost_revertCount;

    constructor(
        RevenueLock _revenueLock,
        ArmadaToken _armToken,
        MockRevenueCounterInv _revenueCounter,
        address[] memory _beneficiaries,
        address[] memory _delegatees
    ) {
        revenueLock = _revenueLock;
        armToken = _armToken;
        revenueCounter = _revenueCounter;
        beneficiaries = _beneficiaries;
        delegatees = _delegatees;
    }

    /// @dev Fuzzed: set revenue to an arbitrary amount
    function setRevenue(uint256 revenue) external {
        revenue = bound(revenue, 0, 5_000_000e18);
        revenueCounter.setRevenue(revenue);
    }

    /// @dev Fuzzed: a random beneficiary calls release with a random delegatee
    function release(uint256 beneficiaryIdx, uint256 delegateeIdx) external {
        beneficiaryIdx = bound(beneficiaryIdx, 0, beneficiaries.length - 1);
        delegateeIdx = bound(delegateeIdx, 0, delegatees.length - 1);

        address beneficiary = beneficiaries[beneficiaryIdx];
        address delegatee = delegatees[delegateeIdx];

        vm.prank(beneficiary);
        try revenueLock.release(delegatee) {
            ghost_releaseCount++;
        } catch {
            ghost_revertCount++;
        }
    }
}

contract RevenueLockInvariantTest is Test {
    RevenueLock public revenueLock;
    ArmadaToken public armToken;
    MockRevenueCounterInv public revenueCounter;
    TimelockController public timelock;
    RevenueLockHandler public handler;

    address public deployer = address(this);
    address[] public beneficiaries;
    address[] public delegatees;
    uint256[] public amounts;

    uint256 constant TOTAL_LOCK = 2_400_000 * 1e18;

    function setUp() public {
        // Deploy mock revenue counter
        revenueCounter = new MockRevenueCounterInv();

        // Deploy timelock
        address[] memory empty = new address[](0);
        timelock = new TimelockController(2 days, empty, empty, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Setup beneficiaries (5 actors)
        beneficiaries.push(address(0xB001));
        beneficiaries.push(address(0xB002));
        beneficiaries.push(address(0xB003));
        beneficiaries.push(address(0xB004));
        beneficiaries.push(address(0xB005));

        amounts.push(800_000 * 1e18);
        amounts.push(600_000 * 1e18);
        amounts.push(400_000 * 1e18);
        amounts.push(300_000 * 1e18);
        amounts.push(300_000 * 1e18);

        // Setup delegatees
        delegatees.push(address(0xD001));
        delegatees.push(address(0xD002));
        delegatees.push(address(0xD003));

        // Deploy RevenueLock
        revenueLock = new RevenueLock(
            address(armToken),
            address(revenueCounter),
            beneficiaries,
            amounts
        );

        // Whitelist all relevant addresses
        address[] memory whitelist = new address[](7);
        whitelist[0] = deployer;
        whitelist[1] = address(revenueLock);
        for (uint256 i = 0; i < 5; i++) {
            whitelist[i + 2] = beneficiaries[i];
        }
        armToken.initWhitelist(whitelist);

        // Authorize RevenueLock for delegateOnBehalf
        address[] memory authDelegators = new address[](1);
        authDelegators[0] = address(revenueLock);
        armToken.initAuthorizedDelegators(authDelegators);

        // Fund RevenueLock
        armToken.transfer(address(revenueLock), TOTAL_LOCK);

        // Deploy handler
        handler = new RevenueLockHandler(
            revenueLock,
            armToken,
            revenueCounter,
            beneficiaries,
            delegatees
        );

        // Target only the handler
        targetContract(address(handler));

        // Mine blocks so getPastVotes works
        vm.roll(block.number + 5);
        vm.warp(block.timestamp + 1 hours);
    }

    /// @notice INV-RL1: ARM.balanceOf(revenueLock) + sum(released) == totalAllocation
    function invariant_supplyConservation() public {
        uint256 lockBalance = armToken.balanceOf(address(revenueLock));
        uint256 totalReleased = 0;
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            totalReleased += revenueLock.released(beneficiaries[i]);
        }
        assertEq(lockBalance + totalReleased, TOTAL_LOCK, "INV-RL1: supply conservation");
    }

    /// @notice INV-RL2: released[b] <= allocation[b] for all beneficiaries
    function invariant_noOverRelease() public {
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            assertLe(
                revenueLock.released(beneficiaries[i]),
                revenueLock.allocation(beneficiaries[i]),
                "INV-RL2: over-release"
            );
        }
    }

    /// @notice INV-RL3: RevenueLock contract itself has no delegatee (vote-inert)
    function invariant_voteInertness() public {
        assertEq(
            armToken.delegates(address(revenueLock)),
            address(0),
            "INV-RL3: RevenueLock should never delegate"
        );
    }

    /// @notice INV-RL4: Any beneficiary that has released > 0 must have a delegatee set
    function invariant_releasedArmIsDelegated() public {
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            if (revenueLock.released(beneficiaries[i]) > 0) {
                assertTrue(
                    armToken.delegates(beneficiaries[i]) != address(0),
                    "INV-RL4: released ARM must be delegated"
                );
            }
        }
    }
}

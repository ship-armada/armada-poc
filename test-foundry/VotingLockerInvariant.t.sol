// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/ArmadaToken.sol";

/// @title VotingLockerHandler — Stateful fuzz handler for VotingLocker invariant testing
/// @dev Drives lock/unlock operations with fuzzed inputs and tracks ghost variables.
contract VotingLockerHandler is Test {
    VotingLocker public locker;
    ArmadaToken public armToken;

    address[] public actors;
    mapping(address => bool) public isActor;

    // Ghost variables
    uint256 public ghost_totalLocked;
    mapping(address => uint256) public ghost_lockedBalance;
    uint256 public ghost_lockCount;
    uint256 public ghost_unlockCount;

    constructor(
        VotingLocker _locker,
        ArmadaToken _armToken,
        address[] memory _actors
    ) {
        locker = _locker;
        armToken = _armToken;
        actors = _actors;
        for (uint256 i = 0; i < _actors.length; i++) {
            isActor[_actors[i]] = true;
        }
    }

    /// @dev Fuzzed lock: pick a random actor and lock a bounded amount
    function lock(uint256 actorIdx, uint256 amount) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        uint256 available = armToken.balanceOf(actor);
        if (available == 0) return;
        amount = bound(amount, 1, available);

        vm.startPrank(actor);
        armToken.approve(address(locker), amount);
        locker.lock(amount);
        vm.stopPrank();

        ghost_totalLocked += amount;
        ghost_lockedBalance[actor] += amount;
        ghost_lockCount++;
    }

    /// @dev Fuzzed unlock: pick a random actor and unlock a bounded amount
    function unlock(uint256 actorIdx, uint256 amount) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        uint256 locked = ghost_lockedBalance[actor];
        if (locked == 0) return;
        amount = bound(amount, 1, locked);

        vm.prank(actor);
        locker.unlock(amount);

        ghost_totalLocked -= amount;
        ghost_lockedBalance[actor] -= amount;
        ghost_unlockCount++;
    }

    /// @dev Advance block to create distinct checkpoints
    function advanceBlock(uint256 blocks) external {
        blocks = bound(blocks, 1, 10);
        vm.roll(block.number + blocks);
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function getActor(uint256 idx) external view returns (address) {
        return actors[idx];
    }
}

/// @title VotingLockerInvariantTest — Foundry invariant test suite for VotingLocker
contract VotingLockerInvariantTest is Test {
    VotingLocker public locker;
    ArmadaToken public armToken;
    VotingLockerHandler public handler;

    address[] public actors;
    uint256 constant TOKENS_PER_ACTOR = 1_000_000 * 1e18;

    function setUp() public {
        // Deploy
        armToken = new ArmadaToken(address(this));
        locker = new VotingLocker(address(armToken));

        // Create actors and fund them
        for (uint256 i = 0; i < 10; i++) {
            address actor = address(uint160(0x5000 + i));
            actors.push(actor);
            armToken.transfer(actor, TOKENS_PER_ACTOR);
        }

        handler = new VotingLockerHandler(locker, armToken, actors);

        targetContract(address(handler));
    }

    // ============ Invariants ============

    /// @notice totalLocked matches sum of all individual locked balances
    function invariant_totalLockedConsistency() public view {
        uint256 sumLocked = 0;
        for (uint256 i = 0; i < actors.length; i++) {
            sumLocked += locker.getLockedBalance(actors[i]);
        }
        assertEq(locker.totalLocked(), sumLocked, "totalLocked != sum of individual balances");
    }

    /// @notice Ghost totalLocked matches contract totalLocked
    function invariant_ghostMatchesContract() public view {
        assertEq(locker.totalLocked(), handler.ghost_totalLocked(), "Ghost totalLocked mismatch");
    }

    /// @notice Individual ghost balances match contract balances
    function invariant_individualGhostMatch() public view {
        for (uint256 i = 0; i < actors.length; i++) {
            address actor = actors[i];
            assertEq(
                locker.getLockedBalance(actor),
                handler.ghost_lockedBalance(actor),
                "Ghost individual balance mismatch"
            );
        }
    }

    /// @notice ARM token conservation: locker balance = totalLocked
    function invariant_armTokenConservation() public view {
        assertEq(
            armToken.balanceOf(address(locker)),
            locker.totalLocked(),
            "Locker ARM balance != totalLocked"
        );
    }

    /// @notice Total ARM in system is conserved (actors + locker = initial funding)
    function invariant_totalArmConserved() public view {
        uint256 total = armToken.balanceOf(address(locker));
        for (uint256 i = 0; i < actors.length; i++) {
            total += armToken.balanceOf(actors[i]);
        }
        // Also account for ARM still held by test contract (deployer)
        total += armToken.balanceOf(address(this));
        assertEq(total, armToken.INITIAL_SUPPLY(), "ARM supply not conserved");
    }

    /// @notice No individual locked balance exceeds their initial funding
    function invariant_noOverLock() public view {
        for (uint256 i = 0; i < actors.length; i++) {
            assertLe(
                locker.getLockedBalance(actors[i]),
                TOKENS_PER_ACTOR,
                "Locked exceeds initial funding"
            );
        }
    }
}

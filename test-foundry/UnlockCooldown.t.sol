// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

// ══════════════════════════════════════════════════════════════════════════════
// Unit + fuzz + scenario tests for the VotingLocker unlock cooldown mechanism.
//
// Covers:
//   1. setGovernor access control and one-time semantics
//   2. recordVoteCooldown access control and max-tracking
//   3. unlock() blocked during cooldown, allowed after
//   4. Fuzz: cooldown always equals max(voteEnd) across votes
//   5. Scenario: vote-and-dump is prevented
//   6. Scenario: voting on multiple proposals extends cooldown to latest
//   7. Invariant: cooldown never decreases
// ══════════════════════════════════════════════════════════════════════════════

contract UnlockCooldownTest is Test {
    ArmadaToken armToken;
    VotingLocker locker;
    ArmadaGovernor governor;
    TimelockController timelock;

    address deployer;
    address alice;
    address bob;
    address treasuryAddr;

    uint256 constant LOCK_AMOUNT = 10_000_000 * 1e18;

    function setUp() public {
        deployer = address(this);
        alice = address(0xA11CE);
        bob = address(0xB0B);
        treasuryAddr = address(0xBABE);

        // Deploy token
        armToken = new ArmadaToken(deployer);

        // Deploy timelock
        address[] memory proposers = new address[](1);
        proposers[0] = address(0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(1 days, proposers, executors, deployer);

        // Deploy locker (deployer is guardian)
        locker = new VotingLocker(address(armToken), deployer, 14 days, address(timelock));

        // Deploy governor
        governor = new ArmadaGovernor(
            address(locker),
            address(armToken),
            payable(address(timelock)),
            treasuryAddr,
            deployer,
            14 days
        );

        // Wire governor into locker
        locker.setGovernor(address(governor));

        // Grant governor roles on timelock
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));

        // Fund actors
        armToken.transfer(alice, LOCK_AMOUNT);
        armToken.transfer(bob, LOCK_AMOUNT);

        // Lock tokens for both actors
        vm.startPrank(alice);
        armToken.approve(address(locker), LOCK_AMOUNT);
        locker.lock(LOCK_AMOUNT);
        vm.stopPrank();

        vm.startPrank(bob);
        armToken.approve(address(locker), LOCK_AMOUNT);
        locker.lock(LOCK_AMOUNT);
        vm.stopPrank();

        // Advance so getPastLockedBalance works
        vm.roll(block.number + 5);
        vm.warp(block.timestamp + 1 hours);
    }

    // ═══════════════════════════════════════════════════════════════════
    // UNIT TESTS: setGovernor
    // ═══════════════════════════════════════════════════════════════════

    function test_setGovernor_onlyGuardianOrTimelock() public {
        // Deploy fresh locker to test setGovernor
        VotingLocker freshLocker = new VotingLocker(
            address(armToken), deployer, 14 days, address(timelock)
        );

        // Non-guardian/non-timelock cannot set governor
        vm.prank(alice);
        vm.expectRevert("VotingLocker: not guardian or timelock");
        freshLocker.setGovernor(address(governor));

        // Guardian (deployer) can set governor
        freshLocker.setGovernor(address(governor));
        assertEq(freshLocker.governor(), address(governor));

        // Timelock can also update governor
        vm.prank(address(timelock));
        freshLocker.setGovernor(address(0x1234));
        assertEq(freshLocker.governor(), address(0x1234));
    }

    function test_setGovernor_rejectsZero() public {
        VotingLocker freshLocker = new VotingLocker(
            address(armToken), deployer, 14 days, address(timelock)
        );

        vm.expectRevert("VotingLocker: zero address");
        freshLocker.setGovernor(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    // UNIT TESTS: recordVoteCooldown
    // ═══════════════════════════════════════════════════════════════════

    function test_recordVoteCooldown_onlyGovernor() public {
        vm.prank(alice);
        vm.expectRevert("VotingLocker: not governor");
        locker.recordVoteCooldown(alice, block.timestamp + 7 days);
    }

    function test_recordVoteCooldown_updatesMax() public {
        uint256 end1 = block.timestamp + 5 days;
        uint256 end2 = block.timestamp + 7 days;
        uint256 end3 = block.timestamp + 3 days; // earlier, should not update

        vm.startPrank(address(governor));
        locker.recordVoteCooldown(alice, end1);
        assertEq(locker.unlockCooldownEnd(alice), end1);

        locker.recordVoteCooldown(alice, end2);
        assertEq(locker.unlockCooldownEnd(alice), end2);

        locker.recordVoteCooldown(alice, end3);
        assertEq(locker.unlockCooldownEnd(alice), end2, "Should keep max");
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // UNIT TESTS: unlock with cooldown
    // ═══════════════════════════════════════════════════════════════════

    function test_unlock_blockedDuringCooldown() public {
        uint256 cooldownEnd = block.timestamp + 7 days;

        vm.prank(address(governor));
        locker.recordVoteCooldown(alice, cooldownEnd);

        vm.prank(alice);
        vm.expectRevert("VotingLocker: cooldown active");
        locker.unlock(1);
    }

    function test_unlock_allowedAfterCooldown() public {
        uint256 cooldownEnd = block.timestamp + 7 days;

        vm.prank(address(governor));
        locker.recordVoteCooldown(alice, cooldownEnd);

        // Warp past cooldown
        vm.warp(cooldownEnd + 1);

        vm.prank(alice);
        locker.unlock(LOCK_AMOUNT);

        assertEq(locker.getLockedBalance(alice), 0);
    }

    function test_unlock_blockedAtExactCooldownEnd() public {
        uint256 cooldownEnd = block.timestamp + 7 days;

        vm.prank(address(governor));
        locker.recordVoteCooldown(alice, cooldownEnd);

        // Warp to exact cooldown end — should still be blocked (uses >)
        vm.warp(cooldownEnd);

        vm.prank(alice);
        vm.expectRevert("VotingLocker: cooldown active");
        locker.unlock(1);
    }

    function test_unlock_noVote_noCooldown() public {
        // User who hasn't voted should be able to unlock immediately
        vm.prank(alice);
        locker.unlock(LOCK_AMOUNT);
        assertEq(locker.getLockedBalance(alice), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCENARIO: Vote-and-dump prevention
    // ═══════════════════════════════════════════════════════════════════

    function test_voteAndDump_prevented() public {
        // Alice creates a proposal
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        uint256 proposalId = governor.propose(
            ProposalType.ParameterChange,
            targets, values, calldatas,
            "Test proposal"
        );

        // Get proposal voteEnd
        (,,, uint256 voteEnd,,,,,) = governor.getProposal(proposalId);

        // Fast-forward past voting delay
        vm.warp(block.timestamp + 2 days + 1);
        vm.roll(block.number + 1);

        // Bob votes
        vm.prank(bob);
        governor.castVote(proposalId, 1); // For

        // Verify cooldown was recorded
        assertEq(locker.unlockCooldownEnd(bob), voteEnd, "Cooldown should match voteEnd");

        // Bob tries to unlock immediately — should fail
        vm.prank(bob);
        vm.expectRevert("VotingLocker: cooldown active");
        locker.unlock(LOCK_AMOUNT);

        // Fast-forward past voting period end
        vm.warp(voteEnd + 1);

        // Now Bob can unlock
        vm.prank(bob);
        locker.unlock(LOCK_AMOUNT);
        assertEq(locker.getLockedBalance(bob), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCENARIO: Multiple proposals extend cooldown
    // ═══════════════════════════════════════════════════════════════════

    function test_multipleProposals_cooldownExtended() public {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        // Alice creates proposal 1 (ParameterChange: 2d delay + 5d voting)
        vm.prank(alice);
        uint256 pid1 = governor.propose(
            ProposalType.ParameterChange,
            targets, values, calldatas,
            "Proposal 1"
        );
        (,,, uint256 voteEnd1,,,,,) = governor.getProposal(pid1);

        // Advance 1 day, then Alice creates proposal 2 (StewardElection: 2d delay + 7d voting)
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 1);

        vm.prank(alice);
        uint256 pid2 = governor.propose(
            ProposalType.StewardElection,
            targets, values, calldatas,
            "Proposal 2"
        );
        (,,, uint256 voteEnd2,,,,,) = governor.getProposal(pid2);

        // voteEnd2 should be later than voteEnd1 (created later + longer voting period)
        assertGt(voteEnd2, voteEnd1, "Proposal 2 should end later");

        // Fast-forward past both voting delays (proposal 1: created at T, delay 2d;
        // proposal 2: created at T+1d, delay 2d — so T+3d covers both)
        vm.warp(block.timestamp + 3 days);
        vm.roll(block.number + 1);

        // Bob votes on proposal 1
        vm.prank(bob);
        governor.castVote(pid1, 1);
        assertEq(locker.unlockCooldownEnd(bob), voteEnd1);

        // Bob votes on proposal 2
        vm.prank(bob);
        governor.castVote(pid2, 1);
        assertEq(locker.unlockCooldownEnd(bob), voteEnd2, "Cooldown should extend to later proposal");

        // Bob cannot unlock before voteEnd2
        vm.warp(voteEnd1 + 1);
        vm.prank(bob);
        vm.expectRevert("VotingLocker: cooldown active");
        locker.unlock(1);

        // Bob can unlock after voteEnd2
        vm.warp(voteEnd2 + 1);
        vm.prank(bob);
        locker.unlock(LOCK_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fuzz: cooldown never decreases after recordVoteCooldown
    function testFuzz_cooldownNeverDecreases(uint256 end1, uint256 end2) public {
        end1 = bound(end1, block.timestamp, block.timestamp + 365 days);
        end2 = bound(end2, block.timestamp, block.timestamp + 365 days);

        vm.startPrank(address(governor));
        locker.recordVoteCooldown(alice, end1);
        uint256 after1 = locker.unlockCooldownEnd(alice);

        locker.recordVoteCooldown(alice, end2);
        uint256 after2 = locker.unlockCooldownEnd(alice);
        vm.stopPrank();

        assertGe(after2, after1, "Cooldown must never decrease");
        assertEq(after2, end1 > end2 ? end1 : end2, "Should be max of both");
    }

    /// @notice Fuzz: unlock reverts iff block.timestamp <= cooldownEnd
    function testFuzz_unlockRespectsTimestamp(uint256 cooldownEnd, uint256 unlockTime) public {
        cooldownEnd = bound(cooldownEnd, block.timestamp + 1, block.timestamp + 365 days);
        unlockTime = bound(unlockTime, block.timestamp, block.timestamp + 400 days);

        vm.prank(address(governor));
        locker.recordVoteCooldown(alice, cooldownEnd);

        vm.warp(unlockTime);

        vm.prank(alice);
        if (unlockTime > cooldownEnd) {
            // Should succeed
            locker.unlock(LOCK_AMOUNT);
            assertEq(locker.getLockedBalance(alice), 0);
        } else {
            // Should revert
            vm.expectRevert("VotingLocker: cooldown active");
            locker.unlock(1);
        }
    }

    /// @notice Fuzz: voting on a proposal sets cooldown to voteEnd
    function testFuzz_voteSetsCorrectCooldown(uint8 support) public {
        support = uint8(bound(support, 0, 2));

        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        uint256 pid = governor.propose(
            ProposalType.ParameterChange,
            targets, values, calldatas,
            "Fuzz proposal"
        );

        (,,, uint256 voteEnd,,,,,) = governor.getProposal(pid);

        // Fast-forward past voting delay
        vm.warp(block.timestamp + 2 days + 1);
        vm.roll(block.number + 1);

        vm.prank(bob);
        governor.castVote(pid, support);

        assertEq(locker.unlockCooldownEnd(bob), voteEnd, "Cooldown should equal voteEnd");
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCENARIO: Non-voter unaffected
    // ═══════════════════════════════════════════════════════════════════

    function test_nonVoter_canUnlockAnytime() public {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        // Alice creates proposal and votes
        vm.prank(alice);
        uint256 pid = governor.propose(
            ProposalType.ParameterChange,
            targets, values, calldatas,
            "Test"
        );
        vm.warp(block.timestamp + 2 days + 1);
        vm.roll(block.number + 1);

        vm.prank(alice);
        governor.castVote(pid, 1);

        // Alice is in cooldown
        vm.prank(alice);
        vm.expectRevert("VotingLocker: cooldown active");
        locker.unlock(1);

        // Bob never voted — can unlock freely
        vm.prank(bob);
        locker.unlock(LOCK_AMOUNT);
        assertEq(locker.getLockedBalance(bob), 0);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// INVARIANT TEST: Cooldown via GovernorHandler
// ══════════════════════════════════════════════════════════════════════════════

/// @title CooldownHandler — Drives vote+unlock sequences for invariant testing
contract CooldownHandler is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;

    address[] public actors;
    mapping(address => uint256) public ghost_maxCooldown;

    constructor(
        ArmadaGovernor _governor,
        ArmadaToken _armToken,
        VotingLocker _locker,
        address[] memory _actors
    ) {
        governor = _governor;
        armToken = _armToken;
        locker = _locker;
        actors = _actors;
    }

    function createAndVote(uint256 actorIdx, uint8 support) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        support = uint8(bound(support, 0, 2));
        address actor = actors[actorIdx];

        if (block.number < 2) vm.roll(2);

        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        // Try to propose
        vm.prank(actor);
        try governor.propose(
            ProposalType.ParameterChange,
            targets, values, calldatas,
            "inv proposal"
        ) returns (uint256 pid) {
            (,,, uint256 voteEnd,,,,,) = governor.getProposal(pid);

            // Fast-forward past voting delay
            vm.warp(block.timestamp + 2 days + 1);
            vm.roll(block.number + 1);

            // All actors vote
            for (uint256 i = 0; i < actors.length; i++) {
                vm.prank(actors[i]);
                try governor.castVote(pid, support) {
                    if (voteEnd > ghost_maxCooldown[actors[i]]) {
                        ghost_maxCooldown[actors[i]] = voteEnd;
                    }
                } catch {}
            }
        } catch {}
    }

    function tryUnlock(uint256 actorIdx, uint256 amount) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        uint256 locked = locker.getLockedBalance(actor);
        if (locked == 0) return;
        amount = bound(amount, 1, locked);

        vm.prank(actor);
        try locker.unlock(amount) {} catch {}
    }

    function advanceTime(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1 hours, 10 days);
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + 1);
    }
}

contract UnlockCooldownInvariantTest is Test {
    ArmadaToken armToken;
    VotingLocker locker;
    ArmadaGovernor governor;
    TimelockController timelock;
    CooldownHandler handler;

    address[] actors;
    uint256 constant TOKENS_PER_ACTOR = 10_000_000 * 1e18;

    function setUp() public {
        armToken = new ArmadaToken(address(this));

        address[] memory proposers = new address[](1);
        proposers[0] = address(0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(1 days, proposers, executors, address(this));

        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));

        address treasuryAddr = address(0xBABE);

        governor = new ArmadaGovernor(
            address(locker),
            address(armToken),
            payable(address(timelock)),
            treasuryAddr,
            address(this),
            14 days
        );

        locker.setGovernor(address(governor));
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));

        for (uint256 i = 0; i < 5; i++) {
            address actor = address(uint160(0x9000 + i));
            actors.push(actor);
            armToken.transfer(actor, TOKENS_PER_ACTOR);

            vm.startPrank(actor);
            armToken.approve(address(locker), TOKENS_PER_ACTOR);
            locker.lock(TOKENS_PER_ACTOR / 2);
            vm.stopPrank();
        }

        vm.roll(block.number + 5);
        vm.warp(block.timestamp + 1 hours);

        handler = new CooldownHandler(governor, armToken, locker, actors);
        targetContract(address(handler));
    }

    /// @notice INV: unlockCooldownEnd never decreases for any actor
    function invariant_cooldownNeverDecreases() public view {
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 onChain = locker.unlockCooldownEnd(actors[i]);
            uint256 ghost = handler.ghost_maxCooldown(actors[i]);
            assertGe(onChain, ghost, "Cooldown decreased below ghost tracking");
        }
    }

    /// @notice INV: on-chain cooldownEnd is always >= ghost max cooldown
    function invariant_cooldownMatchesGhost() public view {
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 onChain = locker.unlockCooldownEnd(actors[i]);
            uint256 ghost = handler.ghost_maxCooldown(actors[i]);
            // On-chain cooldown should exactly equal ghost tracking
            assertEq(onChain, ghost, "On-chain cooldown diverged from ghost");
        }
    }
}

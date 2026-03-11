// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title VoteCooldownTest — Unit and fuzz tests for vote-and-dump prevention
contract VoteCooldownTest is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    uint256 constant ALICE_TOKENS = 20_000_000 * 1e18;
    uint256 constant BOB_TOKENS = 10_000_000 * 1e18;

    function setUp() public {
        armToken = new ArmadaToken(address(this));

        address[] memory proposers = new address[](1);
        proposers[0] = address(0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(1 days, proposers, executors, address(this));

        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));

        treasury = new ArmadaTreasuryGov(address(timelock), address(this), 14 days);

        governor = new ArmadaGovernor(
            address(locker),
            address(armToken),
            payable(address(timelock)),
            address(treasury),
            address(this),
            14 days
        );

        // Set governor on locker
        locker.setGovernor(address(governor));

        // Grant roles
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));

        // Distribute and lock tokens
        armToken.transfer(alice, ALICE_TOKENS);
        armToken.transfer(bob, BOB_TOKENS);

        vm.startPrank(alice);
        armToken.approve(address(locker), ALICE_TOKENS);
        locker.lock(ALICE_TOKENS);
        vm.stopPrank();

        vm.startPrank(bob);
        armToken.approve(address(locker), BOB_TOKENS);
        locker.lock(BOB_TOKENS);
        vm.stopPrank();

        vm.roll(block.number + 5);
        vm.warp(block.timestamp + 1 hours);
    }

    // ═══════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════

    function _createProposal(address proposer) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        return governor.propose(ProposalType.ParameterChange, targets, values, calldatas, "Test");
    }

    // ═══════════════════════════════════════════════════════════
    // setGovernor
    // ═══════════════════════════════════════════════════════════

    function test_setGovernor_revertsIfAlreadySet() public {
        vm.expectRevert("VotingLocker: governor already set");
        locker.setGovernor(address(0x1234));
    }

    function test_setGovernor_revertsIfNotGuardian() public {
        VotingLocker freshLocker = new VotingLocker(
            address(armToken), address(this), 14 days, address(timelock)
        );
        vm.prank(alice);
        vm.expectRevert("VotingLocker: not guardian");
        freshLocker.setGovernor(address(governor));
    }

    function test_setGovernor_revertsOnZeroAddress() public {
        VotingLocker freshLocker = new VotingLocker(
            address(armToken), address(this), 14 days, address(timelock)
        );
        vm.expectRevert("VotingLocker: zero address");
        freshLocker.setGovernor(address(0));
    }

    // ═══════════════════════════════════════════════════════════
    // extendLockUntil
    // ═══════════════════════════════════════════════════════════

    function test_extendLockUntil_revertsIfNotGovernor() public {
        vm.prank(alice);
        vm.expectRevert("VotingLocker: not governor");
        locker.extendLockUntil(alice, block.timestamp + 1000);
    }

    function test_extendLockUntil_doesNotShorten() public {
        // Simulate governor calling extendLockUntil
        vm.startPrank(address(governor));
        locker.extendLockUntil(alice, block.timestamp + 10000);
        uint256 first = locker.lockUntil(alice);

        // Try to set a shorter lock — should not change
        locker.extendLockUntil(alice, block.timestamp + 5000);
        assertEq(locker.lockUntil(alice), first, "lockUntil should not decrease");
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════
    // Core cooldown: vote blocks unlock
    // ═══════════════════════════════════════════════════════════

    function test_votePreventsImmediateUnlock() public {
        uint256 proposalId = _createProposal(alice);

        // Advance past voting delay (2 days)
        vm.warp(block.timestamp + 2 days + 1);

        // Alice votes
        vm.prank(alice);
        governor.castVote(proposalId, 1); // For

        // Try to unlock — should revert
        vm.prank(alice);
        vm.expectRevert("VotingLocker: vote cooldown active");
        locker.unlock(1);
    }

    function test_unlockSucceedsAfterVotingPeriod() public {
        uint256 proposalId = _createProposal(alice);
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        governor.castVote(proposalId, 1);

        // Advance past voting period (5 days for ParameterChange)
        vm.warp(block.timestamp + 5 days + 1);

        // Now unlock should succeed
        vm.prank(alice);
        locker.unlock(1e18);
        assertEq(locker.getLockedBalance(alice), ALICE_TOKENS - 1e18);
    }

    function test_nonVoterCanUnlockDuringVotingPeriod() public {
        uint256 proposalId = _createProposal(alice);
        vm.warp(block.timestamp + 2 days + 1);

        // Only Alice votes
        vm.prank(alice);
        governor.castVote(proposalId, 1);

        // Bob didn't vote — can unlock freely
        vm.prank(bob);
        locker.unlock(1e18);
        assertEq(locker.getLockedBalance(bob), BOB_TOKENS - 1e18);
    }

    // ═══════════════════════════════════════════════════════════
    // Fuzz: lockUntil never decreases
    // ═══════════════════════════════════════════════════════════

    function testFuzz_lockUntilNeverDecreases(uint256 t1, uint256 t2) public {
        t1 = bound(t1, block.timestamp, block.timestamp + 365 days);
        t2 = bound(t2, block.timestamp, block.timestamp + 365 days);

        vm.startPrank(address(governor));
        locker.extendLockUntil(alice, t1);
        uint256 afterFirst = locker.lockUntil(alice);

        locker.extendLockUntil(alice, t2);
        uint256 afterSecond = locker.lockUntil(alice);
        vm.stopPrank();

        assertGe(afterSecond, afterFirst, "lockUntil must never decrease");
    }

    // ═══════════════════════════════════════════════════════════
    // Fuzz: unlock reverts iff cooldown active
    // ═══════════════════════════════════════════════════════════

    function testFuzz_unlockRevertsIffCooldownActive(uint256 timeDelta) public {
        uint256 proposalId = _createProposal(alice);
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        governor.castVote(proposalId, 1);

        uint256 lockEnd = locker.lockUntil(alice);
        // timeDelta from [0, 20 days]
        timeDelta = bound(timeDelta, 0, 20 days);

        // Warp to the cast vote time + timeDelta
        uint256 targetTime = block.timestamp + timeDelta;
        vm.warp(targetTime);

        vm.prank(alice);
        if (targetTime < lockEnd) {
            vm.expectRevert("VotingLocker: vote cooldown active");
            locker.unlock(1);
        } else {
            // Should succeed
            locker.unlock(1);
            assertEq(locker.getLockedBalance(alice), ALICE_TOKENS - 1);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Fuzz: all vote types trigger cooldown
    // ═══════════════════════════════════════════════════════════

    function testFuzz_allVoteTypesTriggerCooldown(uint8 support) public {
        support = uint8(bound(support, 0, 2)); // Against, For, Abstain

        uint256 proposalId = _createProposal(alice);
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        governor.castVote(proposalId, support);

        assertTrue(locker.lockUntil(alice) > 0, "lockUntil should be set after any vote");

        vm.prank(alice);
        vm.expectRevert("VotingLocker: vote cooldown active");
        locker.unlock(1);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title GovernorLifecycleTest
/// @notice Covers E-series (state transition timing) and M8 (zombie proposal expiry)
///         from docs/governance-test-scenarios.md
contract GovernorLifecycleTest is Test {
    ArmadaGovernor governor;
    ArmadaToken armToken;
    VotingLocker locker;
    TimelockController timelock;

    address proposer = address(0x1001);
    address voter = address(0x1002);
    address nonProposer = address(0x1003);
    address treasury = address(0xBABE);

    uint256 constant SUPPLY = 100_000_000e18;
    uint256 constant LOCK_AMOUNT = 10_000_000e18; // 10% of supply

    // Default ParameterChange timing
    uint256 votingDelay;
    uint256 votingPeriod;
    uint256 executionDelay;

    function setUp() public {
        armToken = new ArmadaToken(address(this));

        address[] memory proposers = new address[](1);
        proposers[0] = address(0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(1 days, proposers, executors, address(this));

        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));

        governor = new ArmadaGovernor(
            address(locker), address(armToken), payable(address(timelock)),
            treasury, address(this), 14 days
        );

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));

        // Fund and lock tokens for proposer and voter
        armToken.transfer(proposer, LOCK_AMOUNT);
        armToken.transfer(voter, LOCK_AMOUNT);

        vm.startPrank(proposer);
        armToken.approve(address(locker), LOCK_AMOUNT);
        locker.lock(LOCK_AMOUNT);
        vm.stopPrank();

        vm.startPrank(voter);
        armToken.approve(address(locker), LOCK_AMOUNT);
        locker.lock(LOCK_AMOUNT);
        vm.stopPrank();

        // Advance blocks so getPastLockedBalance works
        vm.roll(block.number + 5);
        vm.warp(block.timestamp + 1 hours);

        // Read default timing params
        (votingDelay, votingPeriod, executionDelay,) =
            governor.proposalTypeParams(ProposalType.ParameterChange);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function _createProposal() internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        return governor.propose(ProposalType.ParameterChange, targets, values, calldatas, "Test");
    }

    function _createAndPassProposal() internal returns (uint256) {
        uint256 pid = _createProposal();

        // Advance to active
        vm.warp(block.timestamp + votingDelay + 1);
        vm.roll(block.number + 1);

        // Vote for
        vm.prank(proposer);
        governor.castVote(pid, 1);
        vm.prank(voter);
        governor.castVote(pid, 1);

        // Advance past voting
        vm.warp(block.timestamp + votingPeriod + 1);

        return pid;
    }

    // ═══════════════════════════════════════════════════════════════════
    // E1: Full lifecycle state transitions
    // ═══════════════════════════════════════════════════════════════════

    function test_E1_fullLifecycle() public {
        uint256 pid = _createProposal();

        // Pending
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Pending));

        // Active
        vm.warp(block.timestamp + votingDelay + 1);
        vm.roll(block.number + 1);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Active));

        // Vote for
        vm.prank(proposer);
        governor.castVote(pid, 1);
        vm.prank(voter);
        governor.castVote(pid, 1);

        // Succeeded
        vm.warp(block.timestamp + votingPeriod + 1);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Succeeded));

        // Queue → Queued
        governor.queue(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Queued));

        // Execute → Executed
        vm.warp(block.timestamp + executionDelay + 1);
        governor.execute(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Executed));
    }

    // ═══════════════════════════════════════════════════════════════════
    // E2: Succeeded proposal sits, then queue (grace period test)
    // ═══════════════════════════════════════════════════════════════════

    function test_E2_succeededCanQueueWithinGracePeriod() public {
        uint256 pid = _createAndPassProposal();
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Succeeded));

        // Wait 13 days (within 14-day grace period)
        vm.warp(block.timestamp + 13 days);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Succeeded));

        // Can still queue
        governor.queue(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Queued));
    }

    // ═══════════════════════════════════════════════════════════════════
    // E3: Cancel while Pending
    // ═══════════════════════════════════════════════════════════════════

    function test_E3_cancelWhilePending() public {
        uint256 pid = _createProposal();
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Pending));

        vm.prank(proposer);
        governor.cancel(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Canceled));
    }

    // ═══════════════════════════════════════════════════════════════════
    // E4: Cancel while Active reverts (cancel only works while Pending)
    // ═══════════════════════════════════════════════════════════════════

    function test_E4_cancelWhileActiveReverts() public {
        uint256 pid = _createProposal();

        // Advance to Active
        vm.warp(block.timestamp + votingDelay + 1);
        vm.roll(block.number + 1);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Active));

        vm.prank(proposer);
        vm.expectRevert("ArmadaGovernor: not pending");
        governor.cancel(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E5: Cancel while Succeeded/Queued/Executed reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_E5_cancelWhileSucceededReverts() public {
        uint256 pid = _createAndPassProposal();
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Succeeded));

        vm.prank(proposer);
        vm.expectRevert("ArmadaGovernor: not pending");
        governor.cancel(pid);
    }

    function test_E5_cancelWhileQueuedReverts() public {
        uint256 pid = _createAndPassProposal();
        governor.queue(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Queued));

        vm.prank(proposer);
        vm.expectRevert("ArmadaGovernor: not pending");
        governor.cancel(pid);
    }

    function test_E5_cancelWhileExecutedReverts() public {
        uint256 pid = _createAndPassProposal();
        governor.queue(pid);
        vm.warp(block.timestamp + executionDelay + 1);
        governor.execute(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Executed));

        vm.prank(proposer);
        vm.expectRevert("ArmadaGovernor: not pending");
        governor.cancel(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E6: Non-proposer cannot cancel
    // ═══════════════════════════════════════════════════════════════════

    function test_E6_nonProposerCannotCancel() public {
        uint256 pid = _createProposal();

        vm.prank(nonProposer);
        vm.expectRevert("ArmadaGovernor: not proposer");
        governor.cancel(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E7: Queue a Defeated proposal reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_E7_queueDefeatedReverts() public {
        uint256 pid = _createProposal();

        // Advance to active, vote against
        vm.warp(block.timestamp + votingDelay + 1);
        vm.roll(block.number + 1);

        vm.prank(proposer);
        governor.castVote(pid, 0); // against
        vm.prank(voter);
        governor.castVote(pid, 0); // against

        // Advance past voting
        vm.warp(block.timestamp + votingPeriod + 1);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Defeated));

        vm.expectRevert("ArmadaGovernor: not succeeded");
        governor.queue(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E8: Queue an already-Queued proposal reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_E8_doubleQueueReverts() public {
        uint256 pid = _createAndPassProposal();
        governor.queue(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Queued));

        vm.expectRevert("ArmadaGovernor: not succeeded");
        governor.queue(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E9: Execute before timelock delay reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_E9_executeBeforeTimelockReverts() public {
        uint256 pid = _createAndPassProposal();
        governor.queue(pid);

        // Don't advance time — still within timelock delay
        vm.expectRevert(); // TimelockController reverts with "not ready"
        governor.execute(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E10: Execute already-Executed proposal reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_E10_doubleExecuteReverts() public {
        uint256 pid = _createAndPassProposal();
        governor.queue(pid);
        vm.warp(block.timestamp + executionDelay + 1);
        governor.execute(pid);

        vm.expectRevert("ArmadaGovernor: not queued");
        governor.execute(pid);
    }

    // ═══════════════════════════════════════════════════════════════════
    // E11: Execute proposal whose underlying call reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_E11_executeWithRevertingCall() public {
        // Create proposal that calls a reverting function
        address[] memory targets = new address[](1);
        targets[0] = address(this); // call this test contract
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("revertingFunction()");

        vm.prank(proposer);
        uint256 pid = governor.propose(
            ProposalType.ParameterChange, targets, values, calldatas, "Reverting"
        );

        // Pass the proposal
        vm.warp(block.timestamp + votingDelay + 1);
        vm.roll(block.number + 1);
        vm.prank(proposer);
        governor.castVote(pid, 1);
        vm.prank(voter);
        governor.castVote(pid, 1);
        vm.warp(block.timestamp + votingPeriod + 1);

        governor.queue(pid);
        vm.warp(block.timestamp + executionDelay + 1);

        // Execute reverts because the target call reverts
        vm.expectRevert();
        governor.execute(pid);
    }

    /// @notice Helper function that always reverts (used by E11)
    function revertingFunction() external pure {
        revert("intentional revert");
    }

    // ═══════════════════════════════════════════════════════════════════
    // E12: Two proposals queued simultaneously with different delays
    // ═══════════════════════════════════════════════════════════════════

    function test_E12_simultaneousProposals() public {
        // Create two proposals
        uint256 pid1 = _createProposal();

        // Need a different calldata for a unique proposal
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        uint256 pid2 = governor.propose(
            ProposalType.ParameterChange, targets, values, calldatas, "Test 2"
        );

        // Pass both
        vm.warp(block.timestamp + votingDelay + 1);
        vm.roll(block.number + 1);

        vm.startPrank(proposer);
        governor.castVote(pid1, 1);
        governor.castVote(pid2, 1);
        vm.stopPrank();

        vm.startPrank(voter);
        governor.castVote(pid1, 1);
        governor.castVote(pid2, 1);
        vm.stopPrank();

        vm.warp(block.timestamp + votingPeriod + 1);

        // Queue both
        governor.queue(pid1);
        governor.queue(pid2);

        // Both should be Queued
        assertEq(uint256(governor.state(pid1)), uint256(ProposalState.Queued));
        assertEq(uint256(governor.state(pid2)), uint256(ProposalState.Queued));

        // Execute both after delay
        vm.warp(block.timestamp + executionDelay + 1);
        governor.execute(pid1);
        governor.execute(pid2);

        assertEq(uint256(governor.state(pid1)), uint256(ProposalState.Executed));
        assertEq(uint256(governor.state(pid2)), uint256(ProposalState.Executed));
    }

    // ═══════════════════════════════════════════════════════════════════
    // E13: Proposal with non-zero ETH value
    // ═══════════════════════════════════════════════════════════════════

    function test_E13_proposalWithEthValue() public {
        // Create proposal that sends ETH
        address[] memory targets = new address[](1);
        targets[0] = address(0xDEAD);
        uint256[] memory values = new uint256[](1);
        values[0] = 1 ether;
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = ""; // just send ETH

        vm.prank(proposer);
        uint256 pid = governor.propose(
            ProposalType.Treasury, targets, values, calldatas, "Send ETH"
        );

        // Get Treasury timing
        (uint256 tvd, uint256 tvp, uint256 ted,) =
            governor.proposalTypeParams(ProposalType.Treasury);

        // Pass
        vm.warp(block.timestamp + tvd + 1);
        vm.roll(block.number + 1);
        vm.prank(proposer);
        governor.castVote(pid, 1);
        vm.prank(voter);
        governor.castVote(pid, 1);
        vm.warp(block.timestamp + tvp + 1);

        governor.queue(pid);
        vm.warp(block.timestamp + ted + 1);

        // Fund the timelock with ETH
        vm.deal(address(timelock), 2 ether);

        // Execute
        governor.execute{value: 0}(pid);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Executed));
    }

    // ═══════════════════════════════════════════════════════════════════
    // M8: Zombie proposal — pass, wait past grace period, becomes Defeated
    // ═══════════════════════════════════════════════════════════════════

    function test_M8_zombieProposalExpires() public {
        uint256 pid = _createAndPassProposal();
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Succeeded));

        // Wait past QUEUE_GRACE_PERIOD (14 days)
        vm.warp(block.timestamp + 15 days);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Defeated));

        // Cannot queue after expiry
        vm.expectRevert("ArmadaGovernor: not succeeded");
        governor.queue(pid);
    }

    function test_M8_zombieAtExactBoundary() public {
        uint256 pid = _createAndPassProposal();

        // Read the voteEnd to be precise
        (,, , uint256 voteEnd,,,,,) = governor.getProposal(pid);

        // At exactly voteEnd + QUEUE_GRACE_PERIOD — still Succeeded
        vm.warp(voteEnd + 14 days);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Succeeded));

        // One second later — Defeated
        vm.warp(voteEnd + 14 days + 1);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Defeated));
    }

    /// @notice Fuzz: succeeded proposals expire after grace period for any delay
    function testFuzz_M8_gracePeriodExpiry(uint256 extraDays) public {
        extraDays = bound(extraDays, 15 days, 365 days);

        uint256 pid = _createAndPassProposal();

        vm.warp(block.timestamp + extraDays);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Defeated));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Additional: Defeated proposal (no quorum) cannot be queued
    // ═══════════════════════════════════════════════════════════════════

    function test_defeatedNoQuorumCannotQueue() public {
        uint256 pid = _createProposal();

        // Advance past voting without any votes
        vm.warp(block.timestamp + votingDelay + votingPeriod + 2);
        assertEq(uint256(governor.state(pid)), uint256(ProposalState.Defeated));

        vm.expectRevert("ArmadaGovernor: not succeeded");
        governor.queue(pid);
    }
}

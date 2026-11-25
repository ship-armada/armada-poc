// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for Security Council veto mechanism and ratification votes.
// ABOUTME: Covers veto lifecycle, SC ejection, proposal restoration on denied veto, and re-veto prevention.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @dev Minimal crowdfund stand-in: the governor reads only finalizedAt (IArmadaCrowdfundReadable).
contract MockFinalizedCrowdfund {
    uint256 public finalizedAt;

    function setFinalizedAt(uint256 t) external {
        finalizedAt = t;
    }
}

/// @title GovernorVetoTest — Tests for SC veto, ratification, ejection, proposal restoration, and re-veto prevention
contract GovernorVetoTest is Test, GovernorDeployHelper {
    // Mirror events from governor for expectEmit
    event ProposalVetoed(uint256 indexed proposalId, bytes32 rationaleHash, uint256 ratificationId);
    event RatificationResolved(uint256 indexed ratificationId, bool vetoUpheld);
    event SecurityCouncilEjected(uint256 indexed ratificationId);
    event SecurityCouncilUpdated(address indexed oldSC, address indexed newSC);
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        uint256 voteStart,
        uint256 voteEnd,
        string description
    );
    event ProposalCanceled(uint256 indexed proposalId);
    event ProposalRestored(uint256 indexed proposalId);
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public carol = address(0xCA201);
    address public sc = address(0x5C5C);       // Security Council
    address public windDown = address(0xD00D);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant RATIFICATION_PERIOD = 14 days;
    uint256 constant FOURTEEN_DAYS = 14 days;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock));

        // Deploy governor
        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );

        // Whitelist participants
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = bob;
        whitelist[3] = address(governor);
        armToken.initWhitelist(whitelist);

        // Distribute tokens: alice 20%, bob 15%, treasury 50%, deployer keeps 15%
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 15 / 100);
        armToken.transfer(address(treasury), TOTAL_SUPPLY * 50 / 100);

        // Delegate to activate voting power
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);

        // Advance block so checkpoints are available
        vm.roll(block.number + 1);

        // Grant timelock roles to governor (PROPOSER, EXECUTOR, CANCELLER)
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));

        // Set Security Council on governor (via timelock)
        vm.prank(address(timelock));
        governor.setSecurityCouncil(sc);
    }

    // ======== Helpers ========

    /// @dev Create a proposal and advance it to Queued state.
    ///      Uses proposalCount() as dummy calldata — an unrecognized selector that
    ///      fail-closed classification auto-promotes to Extended (2d delay, 14d vote, 7d exec, 30% quorum).
    function _createAndQueueProposal(address proposer) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        uint256 proposalId = governor.propose(ProposalType.Extended, targets, values, calldatas, "test proposal");

        // Advance past voting delay (2 days)
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Vote FOR with alice and bob (35% of supply, exceeds 30% Extended quorum)
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR
        vm.prank(bob);
        governor.castVote(proposalId, 1); // FOR

        // Advance past voting period (14 days for Extended)
        vm.warp(block.timestamp + FOURTEEN_DAYS + 1);

        // Queue
        governor.queue(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));

        return proposalId;
    }

    /// @dev Create a proposal with specific calldata and advance to Queued state.
    ///      Unrecognized selectors are auto-promoted to Extended by fail-closed classification,
    ///      so this uses Extended timing (14d voting period, 30% quorum).
    function _createAndQueueProposalWithCalldata(
        address proposer,
        address target,
        bytes memory data,
        string memory desc
    ) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = target;
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = data;

        vm.prank(proposer);
        uint256 proposalId = governor.propose(ProposalType.Extended, targets, values, calldatas, desc);

        vm.warp(block.timestamp + TWO_DAYS + 1);

        vm.prank(alice);
        governor.castVote(proposalId, 1);
        vm.prank(bob);
        governor.castVote(proposalId, 1);

        vm.warp(block.timestamp + FOURTEEN_DAYS + 1);

        governor.queue(proposalId);
        return proposalId;
    }

    // ======== Veto Core ========

    function test_veto_scCanVetoQueuedProposal() public {
        uint256 proposalId = _createAndQueueProposal(alice);
        bytes32 rationaleHash = keccak256("Security risk identified");

        vm.prank(sc);
        governor.veto(proposalId, rationaleHash);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));
    }

    function test_veto_createsRatificationProposal() public {
        uint256 proposalId = _createAndQueueProposal(alice);
        bytes32 rationaleHash = keccak256("Security risk");

        uint256 countBefore = governor.proposalCount();

        vm.prank(sc);
        governor.veto(proposalId, rationaleHash);

        uint256 ratId = governor.proposalCount();
        assertEq(ratId, countBefore + 1);
        assertEq(governor.ratificationOf(ratId), proposalId);
        assertEq(governor.vetoRatificationId(proposalId), ratId);
    }

    function test_veto_ratificationHasCorrectParams() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));

        uint256 ratId = governor.proposalCount();

        (
            address proposer,
            ProposalType pType,
            uint256 voteStart,
            uint256 voteEnd,
            , , , ,
        ) = governor.getProposal(ratId);

        assertEq(proposer, sc, "proposer should be SC");
        assertEq(uint256(pType), uint256(ProposalType.VetoRatification));
        // VetoRatification has 0 voting delay, so voting starts immediately
        assertEq(voteStart, block.timestamp, "voting should start immediately");
        assertEq(voteEnd, block.timestamp + RATIFICATION_PERIOD, "voting period should be 14 days");
    }

    function test_veto_ratificationVotingStartsImmediately() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));

        uint256 ratId = governor.proposalCount();

        // Should be Active immediately (0 voting delay)
        assertEq(uint256(governor.state(ratId)), uint256(ProposalState.Active));

        // Can vote immediately
        vm.prank(alice);
        governor.castVote(ratId, 1); // FOR
    }

    function test_veto_emitsProposalVetoedEvent() public {
        uint256 proposalId = _createAndQueueProposal(alice);
        bytes32 rationaleHash = keccak256("Security risk");

        vm.expectEmit(true, false, false, true);
        emit ProposalVetoed(proposalId, rationaleHash, proposalId + 1);

        vm.prank(sc);
        governor.veto(proposalId, rationaleHash);
    }

    function test_veto_cancelsTimelockOperation() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        // Get the timelock operation ID before veto
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            governor.getProposalActions(proposalId);
        bytes32 timelockId = timelock.hashOperationBatch(
            targets, values, calldatas, 0, bytes32(proposalId)
        );

        // Verify operation is pending in timelock
        assertTrue(timelock.isOperationPending(timelockId));

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));

        // Verify operation is no longer pending
        assertFalse(timelock.isOperationPending(timelockId));
    }

    // ======== Veto Access Control ========

    function test_veto_revertsIfNotSC() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotSecurityCouncil.selector));
        governor.veto(proposalId, keccak256("rationale"));
    }

    function test_veto_revertsIfSCEjected() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        // Eject SC
        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0));

        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_SCEjected.selector));
        governor.veto(proposalId, keccak256("rationale"));
    }

    function test_veto_revertsIfNotQueued() public {
        // Create proposal but don't queue it
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        uint256 proposalId = governor.propose(ProposalType.Extended, targets, values, calldatas, "test");

        // Still Pending
        vm.prank(sc);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotQueued.selector));
        governor.veto(proposalId, keccak256("rationale"));

        // Advance to Active
        vm.warp(block.timestamp + TWO_DAYS + 1);
        vm.prank(sc);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotQueued.selector));
        governor.veto(proposalId, keccak256("rationale"));
    }

    // ======== Ratification Resolution ========

    function test_resolve_forWinsVetoUpheld() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote FOR (uphold veto) — alice and bob
        vm.prank(alice);
        governor.castVote(ratId, 1); // FOR
        vm.prank(bob);
        governor.castVote(ratId, 1); // FOR

        // Advance past voting period (14 days)
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        vm.expectEmit(true, false, false, true);
        emit RatificationResolved(ratId, true);

        governor.resolveRatification(ratId);

        // SC retains seat
        assertEq(governor.securityCouncil(), sc);
        // Original proposal stays cancelled
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));
    }

    function test_resolve_quorumNotMetVetoStands() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // No one votes — quorum not met

        // Advance past voting period
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        vm.expectEmit(true, false, false, true);
        emit RatificationResolved(ratId, true);

        governor.resolveRatification(ratId);

        // SC retains seat
        assertEq(governor.securityCouncil(), sc);
    }

    function test_resolve_tiedVoteVetoStands() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));

        // Tied vote: alice votes FOR (uphold), bob votes AGAINST (deny)
        // alice has 20% of supply, bob has 15% — not equal weight.
        // To get a true tie, give carol tokens equal to alice and have her vote AGAINST.
        // Instead, use alice FOR and bob AGAINST with equal weight:
        // Transfer tokens so alice and bob each have exactly 25% of supply.
        uint256 aliceBal = armToken.balanceOf(alice);
        uint256 bobBal = armToken.balanceOf(bob);
        uint256 equalAmount = (aliceBal + bobBal) / 2;

        // Rebalance: deployer facilitates (alice sends excess to deployer, deployer sends to bob)
        uint256 aliceExcess = aliceBal - equalAmount;
        vm.prank(alice);
        armToken.transfer(deployer, aliceExcess);
        armToken.transfer(bob, aliceExcess);

        // Re-delegate to update checkpoints
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);
        vm.roll(block.number + 1);

        // Create a fresh proposal and veto it (checkpoints are per-block)
        uint256 proposalId2 = _createAndQueueProposal(alice);
        vm.prank(sc);
        governor.veto(proposalId2, keccak256("rationale2"));
        uint256 ratId2 = governor.proposalCount();

        // Now cast tied votes on the ratification
        vm.prank(alice);
        governor.castVote(ratId2, 1); // FOR (uphold veto)
        vm.prank(bob);
        governor.castVote(ratId2, 0); // AGAINST (deny veto)

        // Advance past voting period
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        vm.expectEmit(true, false, false, true);
        emit RatificationResolved(ratId2, true); // vetoUpheld = true

        governor.resolveRatification(ratId2);

        // SC retains seat on a tie — strict majority AGAINST is required for ejection
        assertEq(governor.securityCouncil(), sc);
    }

    function test_resolve_againstWinsSCEjected() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote AGAINST (deny veto) — alice and bob
        vm.prank(alice);
        governor.castVote(ratId, 0); // AGAINST
        vm.prank(bob);
        governor.castVote(ratId, 0); // AGAINST

        // Advance past voting period
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        vm.expectEmit(true, false, false, false);
        emit ProposalRestored(proposalId);
        vm.expectEmit(true, false, false, false);
        emit SecurityCouncilEjected(ratId);
        vm.expectEmit(true, true, false, false);
        emit SecurityCouncilUpdated(sc, address(0));
        vm.expectEmit(true, false, false, true);
        emit RatificationResolved(ratId, false);

        governor.resolveRatification(ratId);

        // SC ejected
        assertEq(governor.securityCouncil(), address(0));
        // Proposal restored to Queued
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    /// @dev WHY (audit-104): the eject path must target the SC that ISSUED the veto,
    ///      not whatever address holds the live `securityCouncil` slot at resolve
    ///      time. Pre-fix, an honest `setSecurityCouncil` rotation during the 14-day
    ///      ratification window punished the new SC for the prior SC's veto. The
    ///      vetoing SC is recoverable from `_proposals[ratId].proposer` (set in
    ///      `_initProposal` during `veto()`); the eject branch now reads that
    ///      field and only zeros the slot when it still holds the vetoer.
    ///
    ///      Scenario: SC_A vetoes a Standard proposal P. Mid-ratification, governance
    ///      legitimately rotates the SC to SC_B (e.g. term expiry, multisig key
    ///      rotation). Community votes AGAINST on the ratification. Resolve must:
    ///      (a) restore P, (b) NOT zero the slot (vetoer SC_A is no longer in role,
    ///      and SC_B did nothing wrong), (c) NOT emit `SecurityCouncilEjected` /
    ///      `SecurityCouncilUpdated`. Off-chain accountability for SC_A remains
    ///      discoverable via `getProposal(ratId).proposer == SC_A`.
    function test_resolve_skipsEjectWhenSCRotatedDuringRatification() public {
        address sc_b = address(0xBEEFB0B);

        uint256 proposalId = _createAndQueueProposal(alice);

        // SC_A (the test fixture's `sc`) vetoes. Records sc as ratification.proposer.
        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Honest rotation mid-window: SC_A → SC_B via timelock (the production path).
        // Modeled here as a direct timelock self-call; the rotation path itself is
        // not under test.
        vm.prank(address(timelock));
        governor.setSecurityCouncil(sc_b);
        assertEq(governor.securityCouncil(), sc_b, "post-rotation slot holds sc_b");

        // Community denies the veto.
        vm.prank(alice);
        governor.castVote(ratId, 0); // AGAINST
        vm.prank(bob);
        governor.castVote(ratId, 0); // AGAINST
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        // Capture logs to verify SecurityCouncilEjected and SecurityCouncilUpdated do
        // NOT fire. ProposalRestored and RatificationResolved still must fire.
        vm.recordLogs();
        governor.resolveRatification(ratId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 ejectedTopic = keccak256("SecurityCouncilEjected(uint256)");
        bytes32 updatedTopic = keccak256("SecurityCouncilUpdated(address,address)");
        bytes32 restoredTopic = keccak256("ProposalRestored(uint256)");
        bytes32 resolvedTopic = keccak256("RatificationResolved(uint256,bool)");
        uint256 ejectedCount;
        uint256 updatedCount;
        uint256 restoredCount;
        uint256 resolvedCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == ejectedTopic) ejectedCount++;
            else if (logs[i].topics[0] == updatedTopic) updatedCount++;
            else if (logs[i].topics[0] == restoredTopic) restoredCount++;
            else if (logs[i].topics[0] == resolvedTopic) resolvedCount++;
        }
        assertEq(ejectedCount, 0, "SC_B not ejected for SC_A's veto");
        assertEq(updatedCount, 0, "no SC slot mutation");
        assertEq(restoredCount, 1, "proposal still restored");
        assertEq(resolvedCount, 1, "ratification resolved");

        // Slot must still hold SC_B — they didn't issue the veto.
        assertEq(governor.securityCouncil(), sc_b, "sc_b retains seat");
        // Vetoer's identity preserved on-chain for off-chain accountability.
        (address recordedVetoer, , , , , , , , ) = governor.getProposal(ratId);
        assertEq(recordedVetoer, sc, "vetoer recoverable from ratification proposer");
        // Proposal restored to Queued.
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    /// @dev WHY (audit-104, edge): if `setSecurityCouncil(address(0))` ran during the
    ///      ratification window (zeroed the slot before the resolve), the resolve must
    ///      NOT emit a misleading `SecurityCouncilUpdated(address(0), address(0))`.
    ///      The vetoer was no longer in the slot at resolve time; the eject is a no-op.
    function test_resolve_skipsEjectWhenSCAlreadyZeroed() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Slot zeroed mid-window (deployer-bootstrap or governance setSecurityCouncil(0)).
        // Use deployer path: deployer is allowed pre-clearDeployer per setSecurityCouncil.
        // But setSecurityCouncil now reverts on same-value; zeroing from non-zero is a real
        // change. Use timelock prank for parity with the prior test.
        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0));
        assertEq(governor.securityCouncil(), address(0));

        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        vm.recordLogs();
        governor.resolveRatification(ratId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 ejectedTopic = keccak256("SecurityCouncilEjected(uint256)");
        bytes32 updatedTopic = keccak256("SecurityCouncilUpdated(address,address)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            assertTrue(logs[i].topics[0] != ejectedTopic, "no eject event");
            assertTrue(logs[i].topics[0] != updatedTopic, "no SC update event");
        }
        assertEq(governor.securityCouncil(), address(0));
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    /// @dev WHY: When the community denies a veto (votes AGAINST), the original proposal
    ///      must be restored to Queued state so it can proceed to execution without
    ///      re-submission through the full governance lifecycle.
    function test_resolve_againstRestoresProposal() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote AGAINST (deny veto)
        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        vm.expectEmit(true, false, false, false);
        emit ProposalRestored(proposalId);

        governor.resolveRatification(ratId);

        // Original proposal should be Queued again (not Canceled)
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    /// @dev WHY: After the community denies a veto and the proposal is restored,
    ///      the timelock must have a fresh pending operation so execute() works
    ///      after the minimum delay.
    function test_resolve_againstRequeuesInTimelock() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            governor.getProposalActions(proposalId);
        bytes32 timelockId = timelock.hashOperationBatch(
            targets, values, calldatas, 0, bytes32(proposalId)
        );

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));

        // Timelock op is cleared by veto
        assertFalse(timelock.isOperationPending(timelockId));

        uint256 ratId = governor.proposalCount();
        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        // Timelock op should be re-scheduled and pending
        assertTrue(timelock.isOperationPending(timelockId));
    }

    /// @dev WHY: A restored proposal must be executable after the fresh timelock delay.
    ///      This verifies the full lifecycle: veto → denied → restored → executed.
    function test_resolve_restoredProposalCanBeExecuted() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        // Advance past fresh timelock delay (getMinDelay = 2 days)
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Execute should succeed
        governor.execute(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Executed));
    }

    function test_resolve_revertsBeforeVotingEnds() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Try to resolve immediately (voting still active)
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_VotingNotEnded.selector));
        governor.resolveRatification(ratId);
    }

    function test_resolve_revertsIfNotRatification() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotARatificationProposal.selector));
        governor.resolveRatification(proposalId);
    }

    function test_resolve_revertsIfAlreadyResolved() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote FOR
        vm.prank(alice);
        governor.castVote(ratId, 1);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        // Try again
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_AlreadyResolved.selector));
        governor.resolveRatification(ratId);
    }

    // ======== Re-Veto Prevention ========

    /// @dev WHY: A restored proposal has vetoRatificationDenied=true, preventing a newly
    ///      appointed SC from vetoing the same proposal again. The community already
    ///      overrode the veto — re-vetoing would undermine community sovereignty.
    function test_reVeto_restoredProposalCannotBeVetoed() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Community denies veto
        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        // SC ejected, set new SC
        assertEq(governor.securityCouncil(), address(0));
        address newSC = address(0x5C5C2);
        vm.prank(address(timelock));
        governor.setSecurityCouncil(newSC);

        // New SC tries to veto restored proposal — should revert
        vm.prank(newSC);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_SingleVetoRule.selector));
        governor.veto(proposalId, keccak256("rationale2"));
    }

    /// @dev WHY: The re-veto prevention is per-proposal, not per-calldata. A future
    ///      proposal with identical calldata is a separate governance decision and
    ///      must be vetoable by the SC.
    function test_reVeto_identicalCalldataOnNewProposalAllowed() public {
        // First proposal: veto denied → restored
        uint256 proposalId1 = _createAndQueueProposalWithCalldata(
            alice, address(governor), abi.encodeWithSignature("proposalCount()"), "first attempt"
        );

        vm.prank(sc);
        governor.veto(proposalId1, keccak256("rationale"));
        uint256 ratId1 = governor.proposalCount();

        vm.prank(alice);
        governor.castVote(ratId1, 0);
        vm.prank(bob);
        governor.castVote(ratId1, 0);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId1);

        // Set new SC
        address newSC = address(0x5C5C2);
        vm.prank(address(timelock));
        governor.setSecurityCouncil(newSC);

        // Second proposal with IDENTICAL calldata — different proposal, should be vetoable
        uint256 proposalId2 = _createAndQueueProposalWithCalldata(
            alice, address(governor), abi.encodeWithSignature("proposalCount()"), "second attempt"
        );

        // New SC can veto — different proposal instance, no vetoRatificationDenied flag
        vm.prank(newSC);
        governor.veto(proposalId2, keccak256("rationale2"));

        assertEq(uint256(governor.state(proposalId2)), uint256(ProposalState.Canceled));
    }

    // ======== Queue/Execute Guards ========

    function test_queue_revertsForRatification() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote FOR so it would be "Succeeded"
        vm.prank(alice);
        governor.castVote(ratId, 1);
        vm.prank(bob);
        governor.castVote(ratId, 1);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        // Try to queue — should revert
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_UseResolveRatification.selector));
        governor.queue(ratId);
    }

    // ======== Post-Ejection ========

    function test_postEjection_cannotVeto() public {
        uint256 proposalId1 = _createAndQueueProposal(alice);

        // Veto → community AGAINST → SC ejected
        vm.prank(sc);
        governor.veto(proposalId1, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        assertEq(governor.securityCouncil(), address(0));

        // Create a new proposal and queue it
        uint256 proposalId2 = _createAndQueueProposal(alice);

        // Ejected SC tries to veto
        vm.prank(sc);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotSecurityCouncil.selector));
        governor.veto(proposalId2, keccak256("rationale"));
    }

    function test_postEjection_governanceCanSetNewSC() public {
        // Eject SC
        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0));

        assertEq(governor.securityCouncil(), address(0));

        // Set new SC via governance (simulated as timelock)
        address newSC = address(0x5C5C2);
        vm.prank(address(timelock));
        governor.setSecurityCouncil(newSC);

        assertEq(governor.securityCouncil(), newSC);
    }

    // ======== Full Lifecycle Integration ========

    function test_fullLifecycle_vetoUpheld() public {
        // 1. Create and queue a proposal
        uint256 proposalId = _createAndQueueProposal(alice);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));

        // 2. SC vetoes
        bytes32 rationaleHash = keccak256("Potential reentrancy vulnerability");
        vm.prank(sc);
        governor.veto(proposalId, rationaleHash);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));

        // 3. Ratification vote begins immediately
        uint256 ratId = governor.proposalCount();
        assertEq(uint256(governor.state(ratId)), uint256(ProposalState.Active));

        // 4. Community votes FOR (uphold veto)
        vm.prank(alice);
        governor.castVote(ratId, 1);
        vm.prank(bob);
        governor.castVote(ratId, 1);

        // 5. Voting ends
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);

        // 6. Resolve
        governor.resolveRatification(ratId);

        // 7. Verify final state
        assertEq(governor.securityCouncil(), sc, "SC should retain seat");
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));
        assertEq(uint256(governor.state(ratId)), uint256(ProposalState.Executed));
    }

    /// @dev WHY: End-to-end lifecycle test for veto-denied path. The community denies
    ///      the veto, the SC is ejected, the proposal is restored to Queued, and
    ///      can be executed after the fresh timelock delay. Verifies no state corruption
    ///      across the full sequence.
    function test_fullLifecycle_vetoDeniedRestoredAndExecuted() public {
        // 1. Create and queue
        uint256 proposalId = _createAndQueueProposal(alice);

        // 2. SC vetoes
        vm.prank(sc);
        governor.veto(proposalId, keccak256("False alarm"));

        // 3. Community votes AGAINST (deny veto)
        uint256 ratId = governor.proposalCount();
        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        // 4. Resolve → proposal restored
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        // 5. SC ejected
        assertEq(governor.securityCouncil(), address(0));

        // 6. Proposal is Queued again (not Canceled)
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));

        // 7. Execute after fresh timelock delay
        vm.warp(block.timestamp + TWO_DAYS + 1);
        governor.execute(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Executed));
    }

    // ======== Voting on Canceled Proposals ========

    /// @dev WHY: castVote() must reject votes on canceled proposals. Without this
    ///      guard, voters waste gas on proposals that can never pass. This also
    ///      prevents misleading vote tallies on canceled proposals.
    function test_castVote_revertsOnCanceledProposal() public {
        // 1. Create a proposal (proposalCount() is unrecognized → auto-promoted to Extended)
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        uint256 proposalId = governor.propose(ProposalType.Extended, targets, values, calldatas, "cancel-vote test");

        // 2. Proposer cancels during Pending state
        vm.prank(alice);
        governor.cancel(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));

        // 3. Advance past voting delay into what would be the voting window
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // 4. Attempt to vote — should revert with Gov_ProposalCanceled
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_ProposalCanceled.selector));
        governor.castVote(proposalId, 1);
    }

    /// @dev WHY: Regression check — castVote() must still work on non-canceled
    ///      proposals after adding the canceled guard.
    function test_castVote_succeedsOnNonCanceledProposal() public {
        // 1. Create a proposal (proposalCount() is unrecognized → auto-promoted to Extended)
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        uint256 proposalId = governor.propose(ProposalType.Extended, targets, values, calldatas, "no-cancel test");

        // 2. Advance past voting delay
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // 3. Vote succeeds
        vm.prank(bob);
        governor.castVote(proposalId, 1);
        assertTrue(governor.hasVoted(proposalId, bob));
    }

    // ======== Veto bootstrap ========

    uint256 constant VETO_BOOTSTRAP = 70 days;
    uint256 constant QUIET_PERIOD = 10 days;

    /// @dev Register a mock crowdfund finalized `agoSeconds` before now.
    function _registerCrowdfundFinalizedAgo(uint256 agoSeconds) internal returns (MockFinalizedCrowdfund cf) {
        cf = new MockFinalizedCrowdfund();
        vm.warp(block.timestamp + agoSeconds); // keep finalizedAt > 0 (block.timestamp starts at 1)
        cf.setFinalizedAt(block.timestamp - agoSeconds);
        governor.setCrowdfundAddress(address(cf));
    }

    /// @dev WHY: the bootstrap's governance parameters are pinned so a constant edit is caught:
    ///      ratification needs 40% quorum, and every proposal type has a 100k ARM quorum floor.
    function test_bootstrap_ratificationQuorumAndFloorPinned() public {
        (, , , uint256 quorumBps) = governor.proposalTypeParams(ProposalType.VetoRatification);
        assertEq(quorumBps, 4000, "ratification quorum 40%");
        assertEq(governor.QUORUM_FLOOR(), 100_000 * 1e18, "quorum floor 100k ARM");
    }

    /// @dev WHY: within 70 days of crowdfund finalization a veto is final: the proposal is
    ///      canceled for good and no ratification vote exists to challenge it (team brief §5).
    function test_bootstrap_vetoWithin70DaysIsFinal() public {
        // Finalized just past the quiet period, so proposing is allowed; queuing takes ~16 days.
        _registerCrowdfundFinalizedAgo(QUIET_PERIOD + 1);
        uint256 proposalId = _createAndQueueProposal(alice);
        uint256 countBefore = governor.proposalCount();
        bytes32 rationaleHash = keccak256("bootstrap veto");

        vm.expectEmit(true, false, false, true);
        emit ProposalVetoed(proposalId, rationaleHash, 0);
        vm.prank(sc);
        governor.veto(proposalId, rationaleHash);

        assertEq(governor.proposalCount(), countBefore, "no ratification proposal created");
        assertEq(governor.vetoRatificationId(proposalId), 0, "no ratification linked");
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled), "permanently canceled");
        assertEq(governor.securityCouncil(), sc, "SC keeps its seat");
    }

    /// @dev WHY: the boundary is strict: at exactly finalizedAt + 70 days the bootstrap has ended
    ///      and a veto triggers the normal ratification vote.
    function test_bootstrap_vetoAtExactly70DaysCreatesRatification() public {
        MockFinalizedCrowdfund cf = _registerCrowdfundFinalizedAgo(QUIET_PERIOD + 1);
        uint256 proposalId = _createAndQueueProposal(alice);
        vm.warp(cf.finalizedAt() + VETO_BOOTSTRAP);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("post-bootstrap veto"));

        uint256 ratId = governor.proposalCount();
        assertEq(governor.ratificationOf(ratId), proposalId, "ratification created");
        assertEq(governor.vetoRatificationId(proposalId), ratId);
    }

    /// @dev WHY: one second before the boundary the veto is still final.
    function test_bootstrap_vetoOneSecondBefore70DaysIsFinal() public {
        MockFinalizedCrowdfund cf = _registerCrowdfundFinalizedAgo(QUIET_PERIOD + 1);
        uint256 proposalId = _createAndQueueProposal(alice);
        vm.warp(cf.finalizedAt() + VETO_BOOTSTRAP - 1);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("last-second veto"));

        assertEq(governor.vetoRatificationId(proposalId), 0, "still final");
    }

    /// @dev WHY: the bootstrap starts at finalization. A crowdfund that never finalizes (still
    ///      open, or canceled: cancel() leaves finalizedAt at 0) must not leave vetoes final
    ///      indefinitely, so a veto before finalization opens the normal ratification vote.
    function test_bootstrap_vetoBeforeFinalizationCreatesRatification() public {
        MockFinalizedCrowdfund cf = new MockFinalizedCrowdfund(); // finalizedAt == 0
        governor.setCrowdfundAddress(address(cf));
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("pre-finalization veto"));

        uint256 ratId = governor.proposalCount();
        assertEq(governor.vetoRatificationId(proposalId), ratId, "ratification before finalization");
        assertEq(governor.ratificationOf(ratId), proposalId);
    }

    /// @dev WHY: early vetoes do not become challengeable retroactively: once the bootstrap ends,
    ///      the earlier vetoed proposal stays canceled and no ratification can be opened for it,
    ///      while a new veto after the bootstrap does get a ratification vote.
    function test_bootstrap_earlyVetoStaysFinalAfterBootstrapEnds() public {
        MockFinalizedCrowdfund cf = _registerCrowdfundFinalizedAgo(QUIET_PERIOD + 1);
        uint256 early = _createAndQueueProposal(alice);
        vm.prank(sc);
        governor.veto(early, keccak256("early"));

        vm.warp(cf.finalizedAt() + VETO_BOOTSTRAP);
        assertEq(uint256(governor.state(early)), uint256(ProposalState.Canceled), "still canceled");
        assertEq(governor.vetoRatificationId(early), 0, "still no ratification");
        vm.prank(sc);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotQueued.selector));
        governor.veto(early, keccak256("again"));

        uint256 late = _createAndQueueProposal(alice);
        vm.prank(sc);
        governor.veto(late, keccak256("late"));
        assertEq(governor.ratificationOf(governor.proposalCount()), late, "late veto is challengeable");
    }

    /// @dev The timelock operation id of a proposal created by _createAndQueueProposal.
    function _queuedOpId(uint256 proposalId) internal view returns (bytes32) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");
        return timelock.hashOperationBatch(targets, values, calldatas, 0, bytes32(proposalId));
    }

    /// @dev WHY: a bootstrap veto is final. No call path may revive the proposal: there is no
    ///      ratification to resolve (resolveRatification of 0 or of the proposal id is refused), it
    ///      cannot be queued, executed or voted on, and its timelock operation stays cancelled,
    ///      both inside the bootstrap and after it ends.
    function test_bootstrap_vetoedProposalCannotBeRevived() public {
        MockFinalizedCrowdfund cf = _registerCrowdfundFinalizedAgo(QUIET_PERIOD + 1);
        uint256 proposalId = _createAndQueueProposal(alice);
        vm.prank(sc);
        governor.veto(proposalId, keccak256("final"));

        for (uint256 pass = 0; pass < 2; pass++) {
            if (pass == 1) vm.warp(cf.finalizedAt() + VETO_BOOTSTRAP + 30 days);
            vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotARatificationProposal.selector));
            governor.resolveRatification(0);
            vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotARatificationProposal.selector));
            governor.resolveRatification(proposalId);
            vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotSucceeded.selector));
            governor.queue(proposalId);
            vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotQueued.selector));
            governor.execute(proposalId);
            vm.prank(bob);
            vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_ProposalCanceled.selector));
            governor.castVote(proposalId, 0);
            assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));
            assertFalse(timelock.isOperation(_queuedOpId(proposalId)), "timelock op stays cancelled");
        }
    }

    /// @dev WHY: overturning a later veto restores only that veto's proposal. An earlier bootstrap
    ///      veto must stay final even when a post-bootstrap ratification goes AGAINST the council,
    ///      re-queues its own proposal and ejects the council.
    function test_bootstrap_laterOverturnedRatificationLeavesEarlierVetoAlone() public {
        MockFinalizedCrowdfund cf = _registerCrowdfundFinalizedAgo(QUIET_PERIOD + 1);
        uint256 early = _createAndQueueProposal(alice);
        vm.prank(sc);
        governor.veto(early, keccak256("early, final"));

        vm.warp(cf.finalizedAt() + VETO_BOOTSTRAP);
        uint256 late = _createAndQueueProposal(alice);
        vm.prank(sc);
        governor.veto(late, keccak256("late, challengeable"));
        uint256 ratId = governor.vetoRatificationId(late);
        assertGt(ratId, 0, "late veto opened a ratification");

        vm.prank(alice);
        governor.castVote(ratId, 0); // AGAINST the veto
        vm.prank(bob);
        governor.castVote(ratId, 0);
        vm.warp(block.timestamp + RATIFICATION_PERIOD + 1);
        governor.resolveRatification(ratId);

        assertEq(governor.securityCouncil(), address(0), "vetoing council ejected");
        assertEq(uint256(governor.state(late)), uint256(ProposalState.Queued), "late proposal restored");
        assertEq(uint256(governor.state(early)), uint256(ProposalState.Canceled), "early veto still final");
        assertEq(governor.vetoRatificationId(early), 0);
        assertFalse(timelock.isOperation(_queuedOpId(early)), "early timelock op not rescheduled");
    }
}

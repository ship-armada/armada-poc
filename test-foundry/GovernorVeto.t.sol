// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for Security Council veto mechanism and ratification votes.
// ABOUTME: Covers veto lifecycle, SC ejection, double-veto prevention, and bond deferral.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title GovernorVetoTest — Tests for SC veto, ratification, ejection, and double-veto prevention
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
    event BondClaimed(uint256 indexed proposalId, address indexed depositor, uint256 amount);

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
    uint256 constant BOND_AMOUNT = 1_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;
    uint256 constant FOURTEEN_DAYS = 14 days;
    uint256 constant MAX_PAUSE = 14 days;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock), deployer, MAX_PAUSE);

        // Deploy governor
        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury),
            deployer,
            MAX_PAUSE
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

    /// @dev Enable ARM transfers and approve governor for bond
    function _enableTransfersAndApproveBond(address proposer) internal {
        armToken.setWindDownContract(windDown);
        vm.prank(windDown);
        armToken.setTransferable(true);

        vm.prank(proposer);
        armToken.approve(address(governor), BOND_AMOUNT);
    }

    /// @dev Create a standard proposal and advance it to Queued state
    function _createAndQueueProposal(address proposer) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        uint256 proposalId = governor.propose(ProposalType.Standard, targets, values, calldatas, "test proposal");

        // Advance past voting delay (2 days)
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Vote FOR with alice and bob (35% of supply, exceeds 20% quorum)
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR
        vm.prank(bob);
        governor.castVote(proposalId, 1); // FOR

        // Advance past voting period (7 days for Standard)
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // Queue
        governor.queue(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));

        return proposalId;
    }

    /// @dev Create a standard proposal with specific calldata and advance to Queued state
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
        uint256 proposalId = governor.propose(ProposalType.Standard, targets, values, calldatas, desc);

        vm.warp(block.timestamp + TWO_DAYS + 1);

        vm.prank(alice);
        governor.castVote(proposalId, 1);
        vm.prank(bob);
        governor.castVote(proposalId, 1);

        vm.warp(block.timestamp + SEVEN_DAYS + 1);

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
        assertEq(voteEnd, block.timestamp + SEVEN_DAYS, "voting period should be 7 days");
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
        vm.expectRevert("ArmadaGovernor: not security council");
        governor.veto(proposalId, keccak256("rationale"));
    }

    function test_veto_revertsIfSCEjected() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        // Eject SC
        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0));

        vm.prank(address(0));
        vm.expectRevert("ArmadaGovernor: SC ejected");
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
        uint256 proposalId = governor.propose(ProposalType.Standard, targets, values, calldatas, "test");

        // Still Pending
        vm.prank(sc);
        vm.expectRevert("ArmadaGovernor: not queued");
        governor.veto(proposalId, keccak256("rationale"));

        // Advance to Active
        vm.warp(block.timestamp + TWO_DAYS + 1);
        vm.prank(sc);
        vm.expectRevert("ArmadaGovernor: not queued");
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

        // Advance past voting period (7 days)
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

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
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        vm.expectEmit(true, false, false, true);
        emit RatificationResolved(ratId, true);

        governor.resolveRatification(ratId);

        // SC retains seat
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
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        vm.expectEmit(true, false, false, false);
        emit SecurityCouncilEjected(ratId);
        vm.expectEmit(true, true, false, false);
        emit SecurityCouncilUpdated(sc, address(0));
        vm.expectEmit(true, false, false, true);
        emit RatificationResolved(ratId, false);

        governor.resolveRatification(ratId);

        // SC ejected
        assertEq(governor.securityCouncil(), address(0));
    }

    function test_resolve_againstStoresCalldataHash() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        // Compute expected calldata hash
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            governor.getProposalActions(proposalId);
        bytes32 expectedHash = keccak256(abi.encode(targets, values, calldatas));

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote AGAINST
        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId);

        // Calldata hash should be stored
        assertTrue(governor.vetoDeniedHashes(expectedHash));
    }

    function test_resolve_revertsBeforeVotingEnds() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Try to resolve immediately (voting still active)
        vm.expectRevert("ArmadaGovernor: voting not ended");
        governor.resolveRatification(ratId);
    }

    function test_resolve_revertsIfNotRatification() public {
        uint256 proposalId = _createAndQueueProposal(alice);

        vm.expectRevert("ArmadaGovernor: not a ratification proposal");
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

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId);

        // Try again
        vm.expectRevert("ArmadaGovernor: already resolved");
        governor.resolveRatification(ratId);
    }

    // ======== Double-Veto Prevention ========

    function test_doubleVeto_identicalCalldataReverts() public {
        // First proposal: create, queue, veto, community AGAINST → deny veto
        uint256 proposalId1 = _createAndQueueProposalWithCalldata(
            alice, address(governor), abi.encodeWithSignature("proposalCount()"), "first attempt"
        );

        vm.prank(sc);
        governor.veto(proposalId1, keccak256("rationale"));
        uint256 ratId1 = governor.proposalCount();

        vm.prank(alice);
        governor.castVote(ratId1, 0); // AGAINST
        vm.prank(bob);
        governor.castVote(ratId1, 0); // AGAINST

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId1);

        // SC ejected, set new SC
        assertEq(governor.securityCouncil(), address(0));
        address newSC = address(0x5C5C2);
        vm.prank(address(timelock));
        governor.setSecurityCouncil(newSC);

        // Second proposal with identical calldata: create, queue
        uint256 proposalId2 = _createAndQueueProposalWithCalldata(
            alice, address(governor), abi.encodeWithSignature("proposalCount()"), "second attempt"
        );

        // New SC tries to veto — should revert
        vm.prank(newSC);
        vm.expectRevert("ArmadaGovernor: community overrode, no double veto");
        governor.veto(proposalId2, keccak256("rationale2"));
    }

    function test_doubleVeto_modifiedCalldataAllowed() public {
        // First: veto denied
        uint256 proposalId1 = _createAndQueueProposalWithCalldata(
            alice, address(governor), abi.encodeWithSignature("proposalCount()"), "first"
        );

        vm.prank(sc);
        governor.veto(proposalId1, keccak256("rationale"));
        uint256 ratId1 = governor.proposalCount();

        vm.prank(alice);
        governor.castVote(ratId1, 0);
        vm.prank(bob);
        governor.castVote(ratId1, 0);

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId1);

        // Set new SC
        address newSC = address(0x5C5C2);
        vm.prank(address(timelock));
        governor.setSecurityCouncil(newSC);

        // Second proposal with DIFFERENT calldata
        uint256 proposalId2 = _createAndQueueProposalWithCalldata(
            alice, address(governor), abi.encodeWithSignature("proposalThreshold()"), "different calldata"
        );

        // New SC can veto — different calldata hash
        vm.prank(newSC);
        governor.veto(proposalId2, keccak256("rationale2"));

        // Veto succeeds
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

        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // Try to queue — should revert
        vm.expectRevert("ArmadaGovernor: use resolveRatification");
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

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId);

        assertEq(governor.securityCouncil(), address(0));

        // Create a new proposal and queue it
        uint256 proposalId2 = _createAndQueueProposal(alice);

        // Ejected SC tries to veto
        vm.prank(sc);
        vm.expectRevert("ArmadaGovernor: not security council");
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

    // ======== Bond Integration ========

    function test_bond_vetoedProposalDeferredUntilRatificationResolves() public {
        _enableTransfersAndApproveBond(alice);
        uint256 aliceBalanceBefore = armToken.balanceOf(alice);

        // Create, queue, veto
        uint256 proposalId = _createAndQueueProposal(alice);
        uint256 ratId = governor.proposalCount() + 1; // will be next

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        ratId = governor.proposalCount();

        // Try to claim bond while ratification in progress — should revert
        vm.expectRevert("ArmadaGovernor: ratification not resolved");
        governor.claimBond(proposalId);

        // Vote FOR (uphold veto) and resolve
        vm.prank(alice);
        governor.castVote(ratId, 1);
        vm.prank(bob);
        governor.castVote(ratId, 1);

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId);

        // Now bond should be claimable
        governor.claimBond(proposalId);

        // Bond returned
        assertEq(armToken.balanceOf(alice), aliceBalanceBefore);
    }

    function test_bond_vetoedProposalClaimableAfterAgainstResolution() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _createAndQueueProposal(alice);

        vm.prank(sc);
        governor.veto(proposalId, keccak256("rationale"));
        uint256 ratId = governor.proposalCount();

        // Vote AGAINST → SC ejected
        vm.prank(alice);
        governor.castVote(ratId, 0);
        vm.prank(bob);
        governor.castVote(ratId, 0);

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId);

        // Bond still claimable (proposer not penalized even if veto was denied)
        governor.claimBond(proposalId);
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
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // 6. Resolve
        governor.resolveRatification(ratId);

        // 7. Verify final state
        assertEq(governor.securityCouncil(), sc, "SC should retain seat");
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));
        assertEq(uint256(governor.state(ratId)), uint256(ProposalState.Executed));
    }

    function test_fullLifecycle_vetoDeniedSCEjected() public {
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

        // 4. Resolve
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveRatification(ratId);

        // 5. SC ejected
        assertEq(governor.securityCouncil(), address(0));

        // 6. Calldata hash stored — identical proposal cannot be vetoed again
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            governor.getProposalActions(proposalId);
        bytes32 calldataHash = keccak256(abi.encode(targets, values, calldatas));
        assertTrue(governor.vetoDeniedHashes(calldataHash));
    }
}

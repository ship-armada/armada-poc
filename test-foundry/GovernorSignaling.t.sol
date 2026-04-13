// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the Signaling proposal type — non-executable, text-only proposals.
// ABOUTME: Covers lifecycle, state transitions, execution guards, immutability, and timing.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title GovernorSignalingTest — Tests for non-executable signaling proposals
contract GovernorSignalingTest is Test, GovernorDeployHelper {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public carol = address(0xCA201);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;
    uint256 constant FOURTEEN_DAYS = 14 days;
    uint256 constant QUEUE_GRACE_PERIOD = 14 days;

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
        address[] memory whitelist = new address[](3);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = bob;
        armToken.initWhitelist(whitelist);

        // Distribute tokens: alice 20%, bob 15%, deployer keeps rest
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 15 / 100);

        // Delegate to activate voting power
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);

        // Advance block so checkpoints are available
        vm.roll(block.number + 1);

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
    }

    // ======== Helpers ========

    /// @dev Create a signaling proposal from the given proposer.
    function _createSignalingProposal(address proposer, string memory description) internal returns (uint256) {
        address[] memory targets = new address[](0);
        uint256[] memory values = new uint256[](0);
        bytes[] memory calldatas = new bytes[](0);

        vm.prank(proposer);
        governor.propose(ProposalType.Signaling, targets, values, calldatas, description);
        return governor.proposalCount();
    }

    /// @dev Create a signaling proposal and advance it to Succeeded state.
    function _createAndPassSignalingProposal(address proposer) internal returns (uint256) {
        uint256 proposalId = _createSignalingProposal(proposer, "test signaling");

        // Advance past voting delay (2 days)
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Vote FOR with alice (20% of eligible supply — meets 20% quorum)
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR

        // Advance past voting period (7 days)
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));
        return proposalId;
    }

    // ======== Lifecycle Tests ========

    // WHY: Core lifecycle — signaling proposals must be creatable with empty arrays
    // and start in Pending state. This validates the propose() guard relaxation.
    function test_signaling_succeedsWithQuorumAndMajority() public {
        uint256 proposalId = _createAndPassSignalingProposal(alice);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));
    }

    // WHY: Signaling proposals must be Defeated when quorum is not reached,
    // using the same quorum logic as executable proposals.
    function test_signaling_defeatedWithoutQuorum() public {
        uint256 proposalId = _createSignalingProposal(alice, "no quorum");

        vm.warp(block.timestamp + TWO_DAYS + 1);
        // No one votes
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Defeated));
    }

    // WHY: Signaling proposals must be Defeated when quorum is met but
    // the majority votes against (againstVotes >= forVotes).
    function test_signaling_defeatedWithMajorityAgainst() public {
        uint256 proposalId = _createSignalingProposal(alice, "majority against");

        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Alice AGAINST (20%), Bob FOR (15%) — quorum met, majority against
        vm.prank(alice);
        governor.castVote(proposalId, 0); // AGAINST
        vm.prank(bob);
        governor.castVote(proposalId, 1); // FOR

        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Defeated));
    }

    // ======== Execution Guard Tests ========

    // WHY: Signaling proposals must never be queueable. The explicit revert in
    // queue() is defense-in-depth — state() also prevents this, but the
    // explicit guard provides a clear error message.
    function test_signaling_cannotQueue() public {
        uint256 proposalId = _createAndPassSignalingProposal(alice);

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_SignalingNoExecution.selector));
        governor.queue(proposalId);
    }

    // WHY: Signaling proposals must never be executable. Since they can never
    // be queued, state() will never return Queued, so execute() would revert
    // with Gov_NotQueued. This test confirms that path.
    function test_signaling_cannotExecute() public {
        uint256 proposalId = _createAndPassSignalingProposal(alice);

        // execute() checks state() == Queued first, which will be Succeeded for signaling
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotQueued.selector));
        governor.execute(proposalId);
    }

    // ======== Input Validation Tests ========

    // WHY: Signaling proposals must reject non-empty targets — they must not carry
    // execution data. This prevents disguising executable proposals as signaling.
    function test_signaling_cannotHaveTargets() public {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_SignalingMustBeEmpty.selector));
        governor.propose(ProposalType.Signaling, targets, values, calldatas, "sneaky");
    }

    // ======== Immutability Tests ========

    // WHY: Signaling params (timing, quorum) are spec-fixed and must not be changeable
    // via governance. Like VetoRatification and Steward, Signaling is immutable.
    function test_signaling_paramsImmutable() public {
        ProposalParams memory newParams = ProposalParams({
            votingDelay: 1 days,
            votingPeriod: 14 days,
            executionDelay: 2 days,
            quorumBps: 3000
        });

        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_ImmutableProposalType.selector));
        governor.setProposalTypeParams(ProposalType.Signaling, newParams);
    }

    // ======== Grace Period Tests ========

    // WHY: Signaling Succeeded state must be permanent. Without the Signaling-specific
    // check in state(), the QUEUE_GRACE_PERIOD (14 days) would cause Succeeded
    // signaling proposals to expire to Defeated — which is incorrect because
    // there is nothing to queue.
    function test_signaling_succeededDoesNotExpire() public {
        uint256 proposalId = _createAndPassSignalingProposal(alice);

        // Advance well past the QUEUE_GRACE_PERIOD
        vm.warp(block.timestamp + QUEUE_GRACE_PERIOD + 30 days);

        // Still Succeeded — not expired
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));
    }

    // ======== Classification Tests ========

    // WHY: Signaling proposals must always use Standard timing (7d vote, 48h delay).
    // They skip _classifyProposal() entirely so there is no risk of Extended
    // auto-promotion. Verify the actual timing matches Standard params.
    function test_signaling_notAutoPromotedToExtended() public {
        uint256 proposalId = _createSignalingProposal(alice, "stays standard");

        (,, uint256 voteStart, uint256 voteEnd,,,,,) = governor.getProposal(proposalId);
        uint256 votingPeriod = voteEnd - voteStart;

        // Standard voting period = 7 days (not 14 days Extended)
        assertEq(votingPeriod, SEVEN_DAYS);
    }

    // ======== Cancellation Tests ========

    // WHY: Signaling proposals follow Standard cancellation rules — proposer can
    // cancel during Pending but not during Active. This verifies both directions.
    function test_signaling_cancelDuringPending() public {
        uint256 proposalId = _createSignalingProposal(alice, "cancel me");

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Pending));

        vm.prank(alice);
        governor.cancel(proposalId);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Canceled));
    }

    function test_signaling_cannotCancelDuringActive() public {
        uint256 proposalId = _createSignalingProposal(alice, "too late");

        vm.warp(block.timestamp + TWO_DAYS + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Active));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotPending.selector));
        governor.cancel(proposalId);
    }
}

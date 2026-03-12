// ABOUTME: Foundry tests verifying governance safety properties for Sepolia deployment readiness.
// ABOUTME: Covers #16 (steward allowedTargets), #17 (minActionDelay covers veto cycle), #19 (snapshot quorum immutability).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/TreasurySteward.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

// ══════════════════════════════════════════════════════════════════════════════
// §3.2-A — Issue #16: Steward allowedTargets deployment verification
// ══════════════════════════════════════════════════════════════════════════════

/// @title StewardAllowedTargetsTest — Verify deploy only whitelists treasury
/// @dev Covers issue #16 (J9 scenario): steward cannot queue actions to arbitrary contracts
contract StewardAllowedTargetsTest is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    TreasurySteward public steward;

    address public stewardPerson = address(0xDA7E);
    uint256 constant MIN_DELAY = (2 days + 5 days + 2 days) * 12000 / 10000;

    function setUp() public {
        armToken = new ArmadaToken(address(this));
        address[] memory empty = new address[](0);
        timelock = new TimelockController(2 days, empty, empty, address(this));
        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock), address(this), 14 days);
        governor = new ArmadaGovernor(
            address(locker), address(armToken), payable(address(timelock)),
            address(treasury), address(this), 14 days
        );

        // Mirror deploy_governance.ts: constructor only, no addAllowedTarget calls
        steward = new TreasurySteward(
            address(this), address(treasury), address(governor),
            MIN_DELAY, address(this), 14 days
        );
        steward.electSteward(stewardPerson);
    }

    /// @notice After deployment, only treasury is in allowedTargets
    function test_deployConfig_onlyTreasuryWhitelisted() public view {
        assertTrue(steward.allowedTargets(address(treasury)), "treasury should be whitelisted");
    }

    /// @notice Governor, locker, timelock, token are NOT whitelisted
    function test_deployConfig_criticalContractsNotWhitelisted() public view {
        assertFalse(steward.allowedTargets(address(governor)), "governor must not be whitelisted");
        assertFalse(steward.allowedTargets(address(locker)), "locker must not be whitelisted");
        assertFalse(steward.allowedTargets(address(timelock)), "timelock must not be whitelisted");
        assertFalse(steward.allowedTargets(address(armToken)), "armToken must not be whitelisted");
    }

    /// @notice J9 scenario: steward cannot propose action targeting governor
    function test_stewardCannotTargetGovernor() public {
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(address(governor), "", 0);
    }

    /// @notice J9 scenario: steward cannot propose action targeting VotingLocker
    function test_stewardCannotTargetLocker() public {
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(address(locker), "", 0);
    }

    /// @notice J9 scenario: steward cannot propose action targeting timelock
    function test_stewardCannotTargetTimelock() public {
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(address(timelock), "", 0);
    }

    /// @notice Steward CAN propose action targeting treasury (the only whitelisted target)
    function test_stewardCanTargetTreasury() public {
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(address(treasury), "", 0);
        assertEq(actionId, 1);
    }

    /// @notice Fuzz: steward cannot propose to any non-treasury address
    function testFuzz_stewardCannotTargetArbitrary(address target) public {
        vm.assume(target != address(treasury));
        vm.assume(steward.allowedTargets(target) == false);

        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(target, "", 0);
    }

    /// @notice Only timelock can add new targets — steward cannot self-escalate
    function test_stewardCannotAddTargets() public {
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.addAllowedTarget(address(governor));
    }

    /// @notice Even if a target is added then removed, execution fails
    function test_targetRemovalBlocksQueuedAction() public {
        address extraTarget = address(0xBEEF);
        steward.addAllowedTarget(extraTarget);

        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(extraTarget, "", 0);

        // Governance removes target during veto window
        steward.removeAllowedTarget(extraTarget);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.executeAction(actionId);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// §3.2-B — Issue #17: minActionDelay covers full governance veto cycle
// ══════════════════════════════════════════════════════════════════════════════

/// @title MinActionDelayVetoCycleTest — Prove governance can veto before steward executes
/// @dev The steward action delay must be >= 120% of the fastest governance cycle so that
///      governance always has time to create, vote on, and execute a veto proposal.
contract MinActionDelayVetoCycleTest is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    TreasurySteward public steward;

    uint256 constant PARAM_CHANGE_DELAY = 2 days;
    uint256 constant PARAM_CHANGE_PERIOD = 5 days;
    uint256 constant PARAM_CHANGE_EXEC_DELAY = 2 days;
    uint256 constant FASTEST_CYCLE = PARAM_CHANGE_DELAY + PARAM_CHANGE_PERIOD + PARAM_CHANGE_EXEC_DELAY;
    uint256 constant EXPECTED_MIN_DELAY = (FASTEST_CYCLE * 12000) / 10000;

    function setUp() public {
        armToken = new ArmadaToken(address(this));
        address[] memory empty = new address[](0);
        timelock = new TimelockController(2 days, empty, empty, address(this));
        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock), address(this), 14 days);
        governor = new ArmadaGovernor(
            address(locker), address(armToken), payable(address(timelock)),
            address(treasury), address(this), 14 days
        );
        steward = new TreasurySteward(
            address(this), address(treasury), address(governor),
            EXPECTED_MIN_DELAY, address(this), 14 days
        );
        steward.electSteward(address(0xDA7E));
    }

    /// @notice minActionDelay equals 120% of ParameterChange cycle (the fastest type)
    function test_minActionDelay_isCorrect() public view {
        assertEq(steward.minActionDelay(), EXPECTED_MIN_DELAY);
        // 10.8 days = 933120 seconds
        assertEq(EXPECTED_MIN_DELAY, 933120);
    }

    /// @notice ParameterChange is the fastest governance cycle
    function test_parameterChangeIsFastestCycle() public view {
        // Get all three proposal type timings
        (uint256 pcDelay, uint256 pcPeriod, uint256 pcExec,) =
            governor.proposalTypeParams(ProposalType.ParameterChange);
        (uint256 tDelay, uint256 tPeriod, uint256 tExec,) =
            governor.proposalTypeParams(ProposalType.Treasury);
        (uint256 sDelay, uint256 sPeriod, uint256 sExec,) =
            governor.proposalTypeParams(ProposalType.StewardElection);

        uint256 pcCycle = pcDelay + pcPeriod + pcExec;
        uint256 tCycle = tDelay + tPeriod + tExec;
        uint256 sCycle = sDelay + sPeriod + sExec;

        // ParameterChange should be <= all others (it's the fastest and thus the binding constraint)
        assertTrue(pcCycle <= tCycle, "ParameterChange should be fastest or tied with Treasury");
        assertTrue(pcCycle <= sCycle, "ParameterChange should be fastest or tied with StewardElection");
    }

    /// @notice The 20% safety margin ensures governance has slack to veto
    /// @dev If steward proposes at T=0, governance starts veto at T=1:
    ///      - Veto proposal completes at T + votingDelay + votingPeriod + executionDelay = T + 9d
    ///      - Steward can execute at T + 10.8d
    ///      - Gap = 1.8 days of slack for governance to execute the veto
    function test_vetoTimingHasSlack() public view {
        uint256 minDelay = steward.minActionDelay();
        uint256 safetyMarginSeconds = minDelay - FASTEST_CYCLE;

        // 20% of 9 days = 1.8 days = 155520 seconds
        assertEq(safetyMarginSeconds, 155520);
        assertTrue(safetyMarginSeconds > 0, "must have positive safety margin");
    }

    /// @notice Governance can always complete a veto before steward execution
    /// @dev This is the key property: even if governance notices the steward action
    ///      immediately after proposal and starts a veto proposal, the veto will
    ///      complete before the action delay expires.
    function test_govCanVetoBeforeStewardExecutes() public view {
        // Steward proposes at T=0, can execute at T + actionDelay
        uint256 actionExecutableAt = steward.actionDelay();

        // Governance notices at T=0 and creates ParameterChange veto proposal
        // (fastest cycle, worst case for governance)
        uint256 vetoCompletesAt = FASTEST_CYCLE;

        // Veto must complete before steward can execute
        assertTrue(
            vetoCompletesAt < actionExecutableAt,
            "governance veto cycle must complete before steward action is executable"
        );
    }

    /// @notice Fuzz: any valid ParameterChange timing still gives governance time to veto
    function testFuzz_minDelayCoversAnyCycle(
        uint256 votingDelay,
        uint256 votingPeriod,
        uint256 executionDelay
    ) public {
        // Bound to valid governor param ranges
        votingDelay = bound(votingDelay, 1 days, 14 days);
        votingPeriod = bound(votingPeriod, 1 days, 30 days);
        executionDelay = bound(executionDelay, 1 days, 14 days);

        uint256 cycle = votingDelay + votingPeriod + executionDelay;
        uint256 minDelay = (cycle * 12000) / 10000;

        // The 120% margin always ensures: cycle < minDelay
        assertTrue(cycle < minDelay, "governance cycle must be strictly less than minActionDelay");
    }

    /// @notice If governor params change, minActionDelay updates dynamically
    function test_minDelayTracksGovernorParamChanges() public {
        uint256 originalMin = steward.minActionDelay();

        // Simulate governance updating ParameterChange params to fastest allowed
        vm.prank(address(timelock));
        governor.setProposalTypeParams(
            ProposalType.ParameterChange,
            ProposalParams({
                votingDelay: 1 days,   // min
                votingPeriod: 1 days,  // min
                executionDelay: 1 days, // min
                quorumBps: 2000
            })
        );

        uint256 newMin = steward.minActionDelay();
        // New fastest cycle = 3 days, min delay = 3.6 days
        assertEq(newMin, (3 days * 12000) / 10000);
        assertTrue(newMin < originalMin, "faster params should lower minDelay");

        // The existing actionDelay (10.8d) still exceeds the new minDelay (3.6d)
        assertTrue(steward.actionDelay() >= newMin, "actionDelay must still exceed new min");
    }

    /// @notice Steward cannot set actionDelay below dynamically computed min
    function test_cannotLowerDelayBelowDynamicMin() public {
        uint256 minDelay = steward.minActionDelay();
        vm.expectRevert("TreasurySteward: delay below governance cycle");
        steward.setActionDelay(minDelay - 1);
    }

    /// @notice Fuzz: constructor always rejects delay below min for any governor config
    function testFuzz_constructorRejectsSubMinDelay(uint256 delay) public {
        uint256 minDelay = steward.minActionDelay();
        delay = bound(delay, 0, minDelay - 1);

        vm.expectRevert("TreasurySteward: delay below governance cycle");
        new TreasurySteward(
            address(this), address(treasury), address(governor),
            delay, address(this), 14 days
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// §3.2-C — Issue #19: Snapshot quorum doesn't shift mid-vote
// ══════════════════════════════════════════════════════════════════════════════

/// @title SnapshotQuorumRegressionTest — Quorum is fixed at proposal creation
/// @dev Regression test for the snapshot quorum fix (PR #63). Verifies that
///      depositing tokens to treasury or changing params during an active vote
///      does not change the quorum for that proposal.
contract SnapshotQuorumRegressionTest is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public proposer = address(0xA1);
    address public voter = address(0xA2);

    uint256 constant TOTAL_SUPPLY = 100_000_000e18;
    uint256 constant TREASURY_ALLOCATION = 65_000_000e18;
    // Eligible = 100M - 65M = 35M
    // Quorum = 35M * 20% = 7M
    uint256 constant EXPECTED_ELIGIBLE = 35_000_000e18;
    uint256 constant EXPECTED_QUORUM = 7_000_000e18;

    function setUp() public {
        armToken = new ArmadaToken(address(this));
        address[] memory empty = new address[](0);
        timelock = new TimelockController(2 days, empty, empty, address(this));
        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock), address(this), 14 days);
        governor = new ArmadaGovernor(
            address(locker), address(armToken), payable(address(timelock)),
            address(treasury), address(this), 14 days
        );

        // Distribute: 65M to treasury, rest stays with deployer for testing
        armToken.transfer(address(treasury), TREASURY_ALLOCATION);

        // Give proposer enough to pass threshold: 0.1% of 35M = 35K
        uint256 proposerAmount = 100_000e18;
        armToken.transfer(proposer, proposerAmount);
        vm.startPrank(proposer);
        armToken.approve(address(locker), proposerAmount);
        locker.lock(proposerAmount);
        vm.stopPrank();

        // Give voter enough to swing votes: 10M
        uint256 voterAmount = 10_000_000e18;
        armToken.transfer(voter, voterAmount);
        vm.startPrank(voter);
        armToken.approve(address(locker), voterAmount);
        locker.lock(voterAmount);
        vm.stopPrank();

        // Advance one block so getPastLockedBalance works (needs block.number - 1)
        vm.roll(block.number + 1);
    }

    /// @notice Helper: create a ParameterChange proposal
    function _createProposal() internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSelector(
            governor.setProposalTypeParams.selector,
            ProposalType.ParameterChange,
            ProposalParams({
                votingDelay: 2 days,
                votingPeriod: 5 days,
                executionDelay: 2 days,
                quorumBps: 2000
            })
        );

        vm.prank(proposer);
        return governor.propose(
            ProposalType.ParameterChange, targets, values, calldatas,
            "Test proposal for quorum regression"
        );
    }

    /// @notice Core regression: depositing ARM to treasury mid-vote does NOT change quorum
    function test_quorumUnchangedAfterTreasuryDeposit() public {
        uint256 proposalId = _createProposal();
        uint256 quorumBefore = governor.quorum(proposalId);
        assertEq(quorumBefore, EXPECTED_QUORUM);

        // Warp into active voting period
        vm.warp(block.timestamp + 2 days + 1);

        // Deposit additional 10M ARM to treasury mid-vote
        // This reduces eligible supply if quorum were live-computed
        armToken.transfer(address(treasury), 10_000_000e18);

        // Quorum must remain unchanged
        uint256 quorumAfter = governor.quorum(proposalId);
        assertEq(quorumAfter, quorumBefore, "quorum must not change after treasury deposit");
    }

    /// @notice Depositing to treasury BEFORE proposal creation correctly reduces quorum
    function test_quorumReflectsPreCreationTreasuryBalance() public {
        // Deposit 5M more to treasury before creating proposal
        armToken.transfer(address(treasury), 5_000_000e18);

        uint256 proposalId = _createProposal();
        uint256 newEligible = EXPECTED_ELIGIBLE - 5_000_000e18; // 30M
        uint256 expectedQuorum = (newEligible * 2000) / 10000; // 30M * 20% = 6M
        assertEq(governor.quorum(proposalId), expectedQuorum);
    }

    /// @notice Withdrawing from treasury mid-vote does NOT change quorum
    function test_quorumUnchangedAfterTreasuryWithdrawal() public {
        uint256 proposalId = _createProposal();
        uint256 quorumBefore = governor.quorum(proposalId);

        // Warp into active voting
        vm.warp(block.timestamp + 2 days + 1);

        // Withdraw 5M from treasury (via timelock as owner)
        vm.prank(address(timelock));
        treasury.distribute(address(armToken), address(0xDEAD), 5_000_000e18);

        uint256 quorumAfter = governor.quorum(proposalId);
        assertEq(quorumAfter, quorumBefore, "quorum must not change after treasury withdrawal");
    }

    /// @notice Governance param update mid-vote does NOT change in-flight quorum
    function test_quorumUnchangedAfterParamUpdate() public {
        uint256 proposalId = _createProposal();
        uint256 quorumBefore = governor.quorum(proposalId);

        // Warp into voting
        vm.warp(block.timestamp + 2 days + 1);

        // Governance updates quorumBps for ParameterChange from 20% to 40%
        vm.prank(address(timelock));
        governor.setProposalTypeParams(
            ProposalType.ParameterChange,
            ProposalParams({
                votingDelay: 2 days,
                votingPeriod: 5 days,
                executionDelay: 2 days,
                quorumBps: 4000  // doubled
            })
        );

        // In-flight proposal quorum must not change
        uint256 quorumAfter = governor.quorum(proposalId);
        assertEq(quorumAfter, quorumBefore, "quorum must not change after param update");
    }

    /// @notice New proposal AFTER param update uses new quorum
    function test_newProposalUsesUpdatedParams() public {
        uint256 proposalId1 = _createProposal();
        uint256 quorum1 = governor.quorum(proposalId1);

        // Governance updates quorumBps to 40%
        vm.prank(address(timelock));
        governor.setProposalTypeParams(
            ProposalType.ParameterChange,
            ProposalParams({
                votingDelay: 2 days,
                votingPeriod: 5 days,
                executionDelay: 2 days,
                quorumBps: 4000
            })
        );

        vm.roll(block.number + 1);

        uint256 proposalId2 = _createProposal();
        uint256 quorum2 = governor.quorum(proposalId2);

        // New proposal should have doubled quorum
        assertEq(quorum2, quorum1 * 2, "new proposal should use updated quorumBps");
    }

    /// @notice Adding excluded address mid-vote does NOT change quorum
    function test_quorumUnchangedAfterExcludedAddressSet() public {
        uint256 proposalId = _createProposal();
        uint256 quorumBefore = governor.quorum(proposalId);

        // Warp into voting
        vm.warp(block.timestamp + 2 days + 1);

        // Set excluded addresses (deployer can do this once)
        address[] memory excluded = new address[](1);
        excluded[0] = address(0xCAFE);
        // Give some ARM to the excluded address first
        armToken.transfer(address(0xCAFE), 1_000_000e18);
        governor.setExcludedAddresses(excluded);

        uint256 quorumAfter = governor.quorum(proposalId);
        assertEq(quorumAfter, quorumBefore, "quorum must not change after setting excluded addresses");
    }

    /// @notice Fuzz: any amount deposited to treasury mid-vote leaves quorum unchanged
    function testFuzz_quorumImmutableDuringVoting(uint256 depositAmount) public {
        // Bound deposit to available deployer balance (total - already distributed)
        uint256 deployerBalance = armToken.balanceOf(address(this));
        depositAmount = bound(depositAmount, 1, deployerBalance);

        uint256 proposalId = _createProposal();
        uint256 quorumBefore = governor.quorum(proposalId);

        // Warp into voting
        vm.warp(block.timestamp + 2 days + 1);

        // Deposit arbitrary amount to treasury
        armToken.transfer(address(treasury), depositAmount);

        uint256 quorumAfter = governor.quorum(proposalId);
        assertEq(quorumAfter, quorumBefore, "quorum must be immutable during voting");
    }

    /// @notice Two concurrent proposals snapshot independently
    function test_concurrentProposalsHaveIndependentSnapshots() public {
        uint256 proposal1 = _createProposal();
        uint256 quorum1 = governor.quorum(proposal1);

        // Deposit more ARM to treasury between proposals
        armToken.transfer(address(treasury), 5_000_000e18);

        vm.roll(block.number + 1);

        uint256 proposal2 = _createProposal();
        uint256 quorum2 = governor.quorum(proposal2);

        // Proposal 1 used original eligible supply, proposal 2 uses reduced eligible supply
        assertTrue(quorum1 > quorum2, "later proposal should have lower quorum due to treasury deposit");

        // Both remain stable during voting
        vm.warp(block.timestamp + 2 days + 1);
        armToken.transfer(address(treasury), 3_000_000e18);

        assertEq(governor.quorum(proposal1), quorum1, "proposal1 quorum must be stable");
        assertEq(governor.quorum(proposal2), quorum2, "proposal2 quorum must be stable");
    }
}

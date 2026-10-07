// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the propose-time guard on timelock.updateDelay(uint256).
// ABOUTME: Prevents a governance action from bricking queue() by setting _minDelay > MIN_EXECUTION_DELAY.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title GovernorUpdateDelayCapTest — Propose-time cap on timelock.updateDelay(uint256).
/// @notice OZ TimelockController._schedule requires `delay >= getMinDelay()`. If governance
///         ever sets _minDelay above the smallest queueable executionDelay, every subsequent
///         queue() reverts permanently. The governor caps updateDelay(X) at propose-time to
///         X <= MIN_EXECUTION_DELAY (2 days), structurally preventing the brick — _minDelay
///         can never exceed the floor on any queueable proposal type's executionDelay.
contract GovernorUpdateDelayCapTest is Test, GovernorDeployHelper {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;

    function setUp() public {
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        armToken = new ArmadaToken(deployer, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock));

        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );

        // Give alice well above the 0.1% proposal threshold so she can propose.
        address[] memory whitelist = new address[](3);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = bob;
        armToken.initWhitelist(whitelist);

        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 10 / 100);

        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);

        vm.roll(block.number + 1);

        // Grant the governor PROPOSER_ROLE so the queue-time tests can call scheduleBatch.
        // Existing propose-only tests don't need this but are unaffected by the grant.
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
    }

    // ======== Helpers ========

    function _singleAction(address target, bytes memory data) internal pure returns (
        address[] memory targets, uint256[] memory values, bytes[] memory calldatas
    ) {
        targets = new address[](1);
        values = new uint256[](1);
        calldatas = new bytes[](1);
        targets[0] = target;
        values[0] = 0;
        calldatas[0] = data;
    }

    function _updateDelayCalldata(uint256 newDelay) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TimelockController.updateDelay.selector, newDelay);
    }

    // ======== Tests ========

    // WHY: Within-cap updateDelay must still be proposable — the guard is a ceiling,
    // not a blanket ban. Verifies normal governance operation (lowering _minDelay
    // below MIN_EXECUTION_DELAY) is unaffected.
    function test_propose_updateDelay_withinCap_succeeds() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(1 days));

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay 1d");
        assertGt(id, 0, "proposal id should be assigned");
    }

    // WHY: The cap equals MIN_EXECUTION_DELAY (2 days). A value exactly at the cap is
    // still safe because every queueable proposal type has executionDelay >= 2d, so the
    // OZ delay >= getMinDelay() check always holds. Boundary test ensures the guard uses
    // strict inequality (>), not >=.
    function test_propose_updateDelay_atCap_succeeds() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(2 days));

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay 2d");
        assertGt(id, 0, "at-cap updateDelay should be proposable");
    }

    // WHY: Core protection. One second over the cap is a permanent queue() brick if
    // executed, so the governor must refuse to create the proposal. Custom error carries
    // the requested value and the cap to aid off-chain monitoring / UI messaging.
    function test_propose_updateDelay_aboveCap_reverts() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(2 days + 1));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ArmadaGovernor.Gov_UpdateDelayExceedsCap.selector, 2 days + 1, 2 days)
        );
        governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay 2d+1");
    }

    // WHY: Unbounded uint256 is the exact scenario in issue #231. A far-out value (e.g.
    // type(uint256).max or hundreds of years) must be rejected the same as a small-but-over
    // value, with no decoding edge cases.
    function test_propose_updateDelay_maxUint_reverts() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(type(uint256).max));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ArmadaGovernor.Gov_UpdateDelayExceedsCap.selector, type(uint256).max, 2 days)
        );
        governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay max");
    }

    // WHY: The guard must catch a bad entry regardless of its position in a multi-action
    // batch. A proposer could otherwise hide a cap-violating call behind innocuous actions.
    function test_propose_updateDelay_batchWithBadEntry_reverts() public {
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);

        // Action 0: innocuous call on the governor (proposalCount() view — unused but legal calldata).
        targets[0] = address(governor);
        values[0] = 0;
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        // Action 1: the offending updateDelay above the cap.
        targets[1] = address(timelock);
        values[1] = 0;
        calldatas[1] = _updateDelayCalldata(30 days);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ArmadaGovernor.Gov_UpdateDelayExceedsCap.selector, 30 days, 2 days)
        );
        governor.propose(ProposalType.Extended, targets, values, calldatas, "batch brick");
    }

    // WHY: The guard is scoped to `target == address(timelock)`. A proposal calling some
    // other contract that happens to share the updateDelay(uint256) selector must NOT be
    // rejected by our cap — it has no bearing on the timelock's _minDelay. Out-of-scope
    // contracts are not our concern; classification handles their risk tier.
    function test_propose_updateDelay_nonTimelockTarget_notBlocked() public {
        // Treasury contract has no updateDelay — but we're proving the guard ignores the
        // selector when the target isn't the timelock. The proposal will be Extended via
        // fail-closed classification (selector not registered), which is fine.
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(treasury), _updateDelayCalldata(100 days));

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "not timelock");
        assertGt(id, 0, "non-timelock target should not trip the updateDelay guard");
    }

    // WHY: Malformed calldata (selector only, no uint256 argument) cannot actually raise
    // _minDelay — it would revert at the timelock during execution. The guard must skip
    // rather than revert, so that accidental/invalid calldata doesn't block propose() with
    // a misleading error. Defensive parity with _classifyProposal's length checks.
    function test_propose_updateDelay_malformedCalldata_skipped() public {
        bytes memory malformed = abi.encodePacked(TimelockController.updateDelay.selector);
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), malformed);

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "malformed");
        assertGt(id, 0, "selector-only updateDelay calldata should be skipped, not reverted");
    }

    // WHY: Signaling proposals carry no calldatas — the guard must not spuriously revert
    // on the empty path. Verifies the `proposalType != Signaling` short-circuit is correct.
    function test_propose_signaling_skipsUpdateDelayGuard() public {
        address[] memory targets = new address[](0);
        uint256[] memory values = new uint256[](0);
        bytes[] memory calldatas = new bytes[](0);

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Signaling, targets, values, calldatas, "signaling only");
        assertGt(id, 0, "signaling proposals must bypass the updateDelay guard");
    }

    // ======== structural _minDelay <= MIN_EXECUTION_DELAY invariant ========

    // WHY: The propose-time cap is the structural prevention against the audit-103
    // brick. Pin the converse axis too: setProposalTypeParams must reject any
    // executionDelay below MIN_EXECUTION_DELAY, so governance cannot lower a
    // queueable type's executionDelay below _minDelay either. Both axes that
    // could produce `_minDelay > executionDelay` are sealed.
    function test_setProposalTypeParams_belowMinExecutionDelay_reverts() public {
        ProposalParams memory bad = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 14 days,
            executionDelay: 1 days,
            quorumBps: 3000
        });
        bytes memory data = abi.encodeWithSelector(
            governor.setProposalTypeParams.selector, ProposalType.Extended, bad
        );
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(governor), data);

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "bad executionDelay 1d");

        (, , uint256 voteStart, uint256 voteEnd, , , , , ) = governor.getProposal(id);
        if (block.timestamp <= voteStart) vm.warp(voteStart + 1);
        vm.prank(alice);
        governor.castVote(id, 1);
        vm.prank(bob);
        governor.castVote(id, 1);
        vm.warp(voteEnd + 1);

        // Queue, warp past executionDelay, then execute. The setProposalTypeParams
        // bound check fires inside execute() and reverts the timelock-driven self-call.
        governor.queue(id);
        vm.warp(block.timestamp + 7 days + 1);
        vm.expectRevert();
        governor.execute(id);
    }

    // ======== queue-time _minDelay widening (defense-in-depth) ========

    // WHY: The propose-time cap at MIN_EXECUTION_DELAY (2d) makes _minDelay > executionDelay
    // structurally unreachable under normal governance. queue() ALSO widens to
    // max(p.executionDelay, getMinDelay()) as defense-in-depth: if a future
    // role-management feature or upgrade ever introduces a path that bypasses
    // _validateTimelockCalldata (see comment at UPDATE_DELAY_SELECTOR), the queue-time
    // widening still averts the audit-103 brick. These regression tests pin the
    // widening so a future refactor cannot silently drop it.
    //
    // Tests use vm.prank(timelock) to simulate the future-bypass scenario — the only
    // way today to drive _minDelay above the structural cap.

    function test_queue_widensSnapshotToLiveMinDelay_standard() public {
        // Snapshot a Standard proposal at the default 2d execution delay.
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(0xDEAD), abi.encodeWithSignature("setRevenueThreshold(uint256)", uint256(1)));
        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Standard, targets, values, calldatas, "std snapshot 2d");

        (, , uint256 voteStart, uint256 voteEnd, , , , , ) = governor.getProposal(id);
        if (block.timestamp <= voteStart) vm.warp(voteStart + 1);
        vm.prank(alice);
        governor.castVote(id, 1);
        vm.warp(voteEnd + 1);

        // Simulate a future-bypass: timelock self-calls updateDelay(8d), driving _minDelay
        // above the cap. In production this path doesn't exist — propose-time guard rejects
        // updateDelay(>2d). Test only.
        vm.prank(address(timelock));
        timelock.updateDelay(8 days);
        assertEq(timelock.getMinDelay(), 8 days, "minDelay raised to 8d (simulated bypass)");

        // Without the widening: scheduleBatch reverts with "TimelockController: insufficient delay".
        // With the widening: queue() forwards 8d (the live floor) and scheduleBatch succeeds.
        uint256 queuedAt = block.timestamp;
        governor.queue(id);

        bytes32 timelockId = timelock.hashOperationBatch(targets, values, calldatas, 0, _proposalSalt(id));
        assertEq(timelock.getTimestamp(timelockId), queuedAt + 8 days, "ETA reflects widened 8d delay");
    }

    function test_queue_widensSnapshotToLiveMinDelay_extended() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(governor), abi.encodeWithSignature("proposalCount()"));
        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "ext snapshot 7d");

        (, , uint256 voteStart, uint256 voteEnd, , , , , ) = governor.getProposal(id);
        if (block.timestamp <= voteStart) vm.warp(voteStart + 1);
        vm.prank(alice);
        governor.castVote(id, 1);
        vm.prank(bob);
        governor.castVote(id, 1);
        vm.warp(voteEnd + 1);

        vm.prank(address(timelock));
        timelock.updateDelay(10 days);

        uint256 queuedAt = block.timestamp;
        governor.queue(id);

        bytes32 timelockId = timelock.hashOperationBatch(targets, values, calldatas, 0, _proposalSalt(id));
        assertEq(timelock.getTimestamp(timelockId), queuedAt + 10 days, "Extended widens to 10d");
    }

    // WHY: The widening is one-directional — it never SHORTENS the snapshot delay. When
    // _minDelay is below the snapshot (the normal case under cap-at-2d), the snapshot wins.
    // Pins the conservative direction and prevents a future refactor from clamping wrong.
    function test_queue_doesNotShortenSnapshotWhenMinDelayLower() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(governor), abi.encodeWithSignature("proposalCount()"));
        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "ext snapshot 7d, minDelay 2d");

        (, , uint256 voteStart, uint256 voteEnd, , , , , ) = governor.getProposal(id);
        if (block.timestamp <= voteStart) vm.warp(voteStart + 1);
        vm.prank(alice);
        governor.castVote(id, 1);
        vm.prank(bob);
        governor.castVote(id, 1);
        vm.warp(voteEnd + 1);

        // _minDelay stays at 2d (constructor default), snapshot = 7d. Snapshot wins.
        assertEq(timelock.getMinDelay(), 2 days, "minDelay unchanged");
        uint256 queuedAt = block.timestamp;
        governor.queue(id);

        bytes32 timelockId = timelock.hashOperationBatch(targets, values, calldatas, 0, _proposalSalt(id));
        assertEq(timelock.getTimestamp(timelockId), queuedAt + 7 days, "snapshot 7d preserved");
    }

    // WHY: queue() salts the timelock operation by bytes32(proposalId). Mirror that
    // exactly so we can re-derive the timelock id to call getTimestamp().
    function _proposalSalt(uint256 proposalId) internal pure returns (bytes32) {
        return bytes32(proposalId);
    }
}

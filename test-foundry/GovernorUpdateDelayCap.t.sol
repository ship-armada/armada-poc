// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the propose-time guard on timelock.updateDelay(uint256).
// ABOUTME: Prevents a governance action from bricking queue() by setting _minDelay > MAX_EXECUTION_DELAY.
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
///         ever sets _minDelay above MAX_EXECUTION_DELAY (14 days), every subsequent queue()
///         reverts permanently. The governor enforces a cap at propose() so this cannot happen
///         via the governor's PROPOSER_ROLE path (the only path today).
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
    // not a blanket ban. Verifies normal governance operation is unaffected.
    function test_propose_updateDelay_withinCap_succeeds() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(7 days));

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay 7d");
        assertGt(id, 0, "proposal id should be assigned");
    }

    // WHY: The cap equals MAX_EXECUTION_DELAY. A value exactly at the cap is still safe
    // because a proposal type with executionDelay == 14d can satisfy delay >= getMinDelay.
    // Boundary test ensures the guard uses strict inequality (>), not >=.
    function test_propose_updateDelay_atCap_succeeds() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(14 days));

        vm.prank(alice);
        uint256 id = governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay 14d");
        assertGt(id, 0, "at-cap updateDelay should be proposable");
    }

    // WHY: Core protection. One day over the cap is a permanent queue() brick if executed,
    // so the governor must refuse to create the proposal. Custom error carries the
    // requested value and the cap to aid off-chain monitoring / UI messaging.
    function test_propose_updateDelay_aboveCap_reverts() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(15 days));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ArmadaGovernor.Gov_UpdateDelayExceedsCap.selector, 15 days, 14 days)
        );
        governor.propose(ProposalType.Extended, targets, values, calldatas, "updateDelay 15d");
    }

    // WHY: Unbounded uint256 is the exact scenario in issue #231. A far-out value (e.g.
    // type(uint256).max or hundreds of years) must be rejected the same as a small-but-over
    // value, with no decoding edge cases.
    function test_propose_updateDelay_maxUint_reverts() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calldatas) =
            _singleAction(address(timelock), _updateDelayCalldata(type(uint256).max));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ArmadaGovernor.Gov_UpdateDelayExceedsCap.selector, type(uint256).max, 14 days)
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
            abi.encodeWithSelector(ArmadaGovernor.Gov_UpdateDelayExceedsCap.selector, 30 days, 14 days)
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
}

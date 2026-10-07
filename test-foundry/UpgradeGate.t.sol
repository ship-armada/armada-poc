// SPDX-License-Identifier: MIT
// ABOUTME: Foundry unit and fuzz tests for UpgradeGate — the Launch Team co-sign on gated governance actions.
// ABOUTME: Covers per-proposal approval binding, replay resistance, revocation, and two-step team rotation.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/UpgradeGate.sol";

contract UpgradeGateTest is Test {
    UpgradeGate internal gate;
    address internal constant TEAM = address(0x7EA4);
    address internal constant NEW_TEAM = address(0x7EA5);
    address internal constant OUTSIDER = address(0xBAD);
    address internal constant GOVERNOR = address(0x6070);
    address internal constant TOKEN = address(0x70CE);

    bytes4 internal constant UPGRADE_TO = bytes4(keccak256("upgradeTo(address)"));
    bytes4 internal constant UPGRADE_TO_AND_CALL = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
    bytes4 internal constant ADD_DELEGATOR = bytes4(keccak256("addAuthorizedDelegator(address)"));

    event ProposalApproved(uint256 indexed proposalId, bytes32 proposalHash);
    event ProposalApprovalRevoked(uint256 indexed proposalId, bytes32 proposalHash);
    event LaunchTeamTransferStarted(address indexed currentTeam, address indexed pendingTeam);
    event LaunchTeamTransferred(address indexed previousTeam, address indexed newTeam);

    function setUp() public {
        gate = new UpgradeGate(TEAM);
    }

    // ======== helpers ========

    function _one(address target, bytes memory data) internal pure returns (
        address[] memory targets, uint256[] memory values, bytes[] memory calldatas
    ) {
        targets = new address[](1);
        values = new uint256[](1);
        calldatas = new bytes[](1);
        targets[0] = target;
        calldatas[0] = data;
    }

    function _upgrade(address impl) internal pure returns (
        address[] memory, uint256[] memory, bytes[] memory
    ) {
        return _one(GOVERNOR, abi.encodeWithSelector(UPGRADE_TO, impl));
    }

    function _approve(uint256 id, address[] memory t, uint256[] memory v, bytes[] memory c) internal {
        vm.prank(TEAM);
        gate.approve(id, t, v, c);
    }

    // ======== construction ========

    // WHY: a gate with no team could never approve anything, permanently freezing upgrades.
    function test_constructor_rejectsZeroTeam() public {
        vm.expectRevert(UpgradeGate.Gate_ZeroAddress.selector);
        new UpgradeGate(address(0));
    }

    function test_constructor_setsTeam() public view {
        assertEq(gate.launchTeam(), TEAM);
    }

    // ======== gated selectors ========

    // WHY: these three calls are the permanent-takeover routes (governor/RevenueCounter upgrade,
    // delegation hijack via a new authorized delegator). The list is fixed in code.
    function test_isGated_coversExactlyTheTakeoverRoutes() public view {
        assertTrue(gate.isGated(UPGRADE_TO));
        assertTrue(gate.isGated(UPGRADE_TO_AND_CALL));
        assertTrue(gate.isGated(ADD_DELEGATOR));
    }

    // WHY: ordinary governance (distributions, parameters, steward actions) must not need
    // Launch Team sign-off — the gate covers only the takeover routes.
    function testFuzz_isGated_falseForOtherSelectors(bytes4 selector) public view {
        vm.assume(selector != UPGRADE_TO && selector != UPGRADE_TO_AND_CALL && selector != ADD_DELEGATOR);
        assertFalse(gate.isGated(selector));
    }

    // ======== check ========

    // WHY: default-fail — a gated action without Launch Team approval must never execute.
    function test_check_revertsForUnapprovedUpgradeTo() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    function test_check_revertsForUnapprovedUpgradeToAndCall() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) =
            _one(GOVERNOR, abi.encodeWithSelector(UPGRADE_TO_AND_CALL, address(0x1111), hex"1234"));
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    function test_check_revertsForUnapprovedAddAuthorizedDelegator() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) =
            _one(TOKEN, abi.encodeWithSelector(ADD_DELEGATOR, address(0x2222)));
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    // WHY: a gated action hidden among ordinary actions still requires approval of the whole proposal.
    function test_check_revertsWhenGatedActionIsMixedIn() public {
        address[] memory t = new address[](2);
        uint256[] memory v = new uint256[](2);
        bytes[] memory c = new bytes[](2);
        t[0] = address(0x7EA5);
        c[0] = abi.encodeWithSignature("distribute(address,address,uint256)", address(1), address(2), 3);
        t[1] = GOVERNOR;
        c[1] = abi.encodeWithSelector(UPGRADE_TO, address(0x1111));
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    // WHY: proposals with no gated action pass without any team involvement.
    function testFuzz_check_passesWithoutGatedAction(uint256 id, address target, bytes4 selector, bytes memory args)
        public view
    {
        vm.assume(selector != UPGRADE_TO && selector != UPGRADE_TO_AND_CALL && selector != ADD_DELEGATOR);
        (address[] memory t, uint256[] memory v, bytes[] memory c) =
            _one(target, abi.encodePacked(selector, args));
        gate.check(id, t, v, c);
    }

    // WHY: calldata shorter than a selector (e.g. a plain ETH transfer) carries no gated call.
    function test_check_passesForShortCalldata() public view {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _one(GOVERNOR, hex"3659cf");
        gate.check(7, t, v, c);
    }

    // ======== approve / revoke ========

    function test_approve_allowsExactProposal() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        vm.expectEmit(true, false, false, true);
        emit ProposalApproved(7, gate.proposalHash(7, t, v, c));
        _approve(7, t, v, c);
        assertTrue(gate.isApproved(7, t, v, c));
        gate.check(7, t, v, c);
    }

    // WHY: only the Launch Team may approve; governance or anyone else approving would void the co-sign.
    function testFuzz_approve_onlyTeam(address caller) public {
        vm.assume(caller != TEAM);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        vm.prank(caller);
        vm.expectRevert(UpgradeGate.Gate_NotLaunchTeam.selector);
        gate.approve(7, t, v, c);
    }

    // WHY: replay — an approval for one proposal must never satisfy another proposal with the
    // identical actions (e.g. re-proposing upgradeTo(V2) after V3 fixed a bug in V2).
    function testFuzz_approval_notReusableByAnotherProposalId(uint256 otherId) public {
        vm.assume(otherId != 7);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        _approve(7, t, v, c);
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, otherId));
        gate.check(otherId, t, v, c);
    }

    // WHY: bait-and-switch — approval binds the exact implementation address.
    function testFuzz_approval_bindsCalldata(address otherImpl) public {
        vm.assume(otherImpl != address(0x1111));
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        _approve(7, t, v, c);
        (address[] memory t2, uint256[] memory v2, bytes[] memory c2) = _upgrade(otherImpl);
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t2, v2, c2);
    }

    // WHY: approval binds the target — approving a governor upgrade must not cover the same call
    // aimed at a different proxy.
    function testFuzz_approval_bindsTarget(address otherTarget) public {
        vm.assume(otherTarget != GOVERNOR);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        _approve(7, t, v, c);
        t[0] = otherTarget;
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    // WHY: approval binds attached ETH values too, so the approved proposal is exactly what executes.
    function testFuzz_approval_bindsValues(uint256 value) public {
        vm.assume(value != 0);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        _approve(7, t, v, c);
        v[0] = value;
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    // WHY: the team must be able to withdraw approval any time before execution.
    function test_revoke_removesApproval() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        _approve(7, t, v, c);
        vm.expectEmit(true, false, false, true);
        emit ProposalApprovalRevoked(7, gate.proposalHash(7, t, v, c));
        vm.prank(TEAM);
        gate.revoke(7, t, v, c);
        assertFalse(gate.isApproved(7, t, v, c));
        vm.expectRevert(abi.encodeWithSelector(UpgradeGate.Gate_NotApproved.selector, 7));
        gate.check(7, t, v, c);
    }

    function testFuzz_revoke_onlyTeam(address caller) public {
        vm.assume(caller != TEAM);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        _approve(7, t, v, c);
        vm.prank(caller);
        vm.expectRevert(UpgradeGate.Gate_NotLaunchTeam.selector);
        gate.revoke(7, t, v, c);
    }

    // ======== team rotation ========

    // WHY: rotation is two-step so a mistyped address cannot strand the gate (default-fail would
    // otherwise freeze upgrades and new cohorts forever). Nothing changes until the new team accepts.
    function test_rotation_requiresAcceptance() public {
        vm.expectEmit(true, true, false, false);
        emit LaunchTeamTransferStarted(TEAM, NEW_TEAM);
        vm.prank(TEAM);
        gate.transferLaunchTeam(NEW_TEAM);
        assertEq(gate.launchTeam(), TEAM);
        assertEq(gate.pendingLaunchTeam(), NEW_TEAM);

        vm.expectEmit(true, true, false, false);
        emit LaunchTeamTransferred(TEAM, NEW_TEAM);
        vm.prank(NEW_TEAM);
        gate.acceptLaunchTeam();
        assertEq(gate.launchTeam(), NEW_TEAM);
        assertEq(gate.pendingLaunchTeam(), address(0));
    }

    // WHY: after rotation the old team has no powers and the new team has all of them.
    function test_rotation_movesAllPowers() public {
        vm.prank(TEAM);
        gate.transferLaunchTeam(NEW_TEAM);
        vm.prank(NEW_TEAM);
        gate.acceptLaunchTeam();

        (address[] memory t, uint256[] memory v, bytes[] memory c) = _upgrade(address(0x1111));
        vm.prank(TEAM);
        vm.expectRevert(UpgradeGate.Gate_NotLaunchTeam.selector);
        gate.approve(7, t, v, c);

        vm.prank(NEW_TEAM);
        gate.approve(7, t, v, c);
        gate.check(7, t, v, c);
    }

    // WHY: governance (or anyone) must not be able to redirect the gate.
    function testFuzz_transferLaunchTeam_onlyTeam(address caller) public {
        vm.assume(caller != TEAM);
        vm.prank(caller);
        vm.expectRevert(UpgradeGate.Gate_NotLaunchTeam.selector);
        gate.transferLaunchTeam(caller);
    }

    function testFuzz_acceptLaunchTeam_onlyPending(address caller) public {
        vm.assume(caller != NEW_TEAM);
        vm.prank(TEAM);
        gate.transferLaunchTeam(NEW_TEAM);
        vm.prank(caller);
        vm.expectRevert(UpgradeGate.Gate_NotPendingLaunchTeam.selector);
        gate.acceptLaunchTeam();
    }

    function test_transferLaunchTeam_rejectsZero() public {
        vm.prank(TEAM);
        vm.expectRevert(UpgradeGate.Gate_ZeroAddress.selector);
        gate.transferLaunchTeam(address(0));
    }

    // WHY: the team can cancel a pending handover by nominating itself; the old nominee can then
    // no longer accept.
    function test_transferLaunchTeam_canBeOverwritten() public {
        vm.prank(TEAM);
        gate.transferLaunchTeam(NEW_TEAM);
        vm.prank(TEAM);
        gate.transferLaunchTeam(TEAM);
        vm.prank(NEW_TEAM);
        vm.expectRevert(UpgradeGate.Gate_NotPendingLaunchTeam.selector);
        gate.acceptLaunchTeam();
    }
}

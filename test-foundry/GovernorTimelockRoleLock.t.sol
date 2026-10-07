// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the production timelock role layout: governor holds every role, nobody holds admin.
// ABOUTME: Proves role-management proposals cannot add proposers or strip the governor once admin is revoked.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title GovernorTimelockRoleLockTest
/// @notice Mirrors the production deploy: the governor holds PROPOSER/EXECUTOR/CANCELLER, the
///         timelock's admin role over itself is revoked, and the deployer renounces its admin.
///         With no admin left, a passed proposal can neither grant a second proposer (which
///         would bypass the governor's checks) nor revoke the governor's roles (which would
///         brick governance) — both reach the timelock and revert there.
contract GovernorTimelockRoleLockTest is Test, GovernorDeployHelper {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public attacker = address(0xBAD);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;

    function setUp() public {
        timelock = new TimelockController(2 days, new address[](0), new address[](0), deployer);
        armToken = new ArmadaToken(deployer, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock));
        governor = _deployGovernorProxy(address(armToken), payable(address(timelock)), address(treasury));

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

        // Production role layout (scripts/deploy_governance.ts + deploy_crowdfund.ts step 16).
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
        bytes32 admin = timelock.TIMELOCK_ADMIN_ROLE();
        timelock.revokeRole(admin, address(timelock));
        timelock.renounceRole(admin, deployer);
    }

    function _passAndQueue(address target, bytes memory data) internal returns (uint256 id) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        targets[0] = target;
        calldatas[0] = data;

        vm.prank(alice);
        id = governor.propose(ProposalType.Extended, targets, values, calldatas, "role change");
        (, , uint256 voteStart, uint256 voteEnd, , , , , ) = governor.getProposal(id);
        vm.warp(voteStart + 1);
        vm.prank(alice);
        governor.castVote(id, 1);
        vm.prank(bob);
        governor.castVote(id, 1);
        vm.warp(voteEnd + 1);
        governor.queue(id);
        vm.warp(block.timestamp + 7 days + 1);
    }

    // WHY: sanity check that the fixture matches production — nobody holds admin.
    function test_noAdminRemains() public view {
        bytes32 admin = timelock.TIMELOCK_ADMIN_ROLE();
        assertFalse(timelock.hasRole(admin, address(timelock)));
        assertFalse(timelock.hasRole(admin, deployer));
        assertFalse(timelock.hasRole(admin, address(governor)));
    }

    // WHY: a second proposer/executor could schedule upgrades directly on the timelock and skip
    // every governor-side check (including the upgrade gate). With admin revoked the grant
    // reverts at execution, so a passed proposal cannot create one.
    function test_grantRoleProposal_revertsAtExecution() public {
        bytes32 proposer = timelock.PROPOSER_ROLE();
        uint256 id = _passAndQueue(
            address(timelock), abi.encodeCall(timelock.grantRole, (proposer, attacker))
        );
        vm.expectRevert("TimelockController: underlying transaction reverted");
        governor.execute(id);
        assertFalse(timelock.hasRole(proposer, attacker));
    }

    // WHY: revoking the governor's roles would brick governance. The governor no longer needs a
    // propose-time denylist for this: such a proposal is accepted but reverts at the timelock,
    // and the governor keeps its roles.
    function test_revokeGovernorRoleProposal_revertsAtExecution() public {
        bytes32 executor = timelock.EXECUTOR_ROLE();
        uint256 id = _passAndQueue(
            address(timelock), abi.encodeCall(timelock.revokeRole, (executor, address(governor)))
        );
        vm.expectRevert("TimelockController: underlying transaction reverted");
        governor.execute(id);
        assertTrue(timelock.hasRole(executor, address(governor)));
    }

    // WHY: renouncing on the governor's behalf fails because the timelock is not the account;
    // the governor keeps its proposer role.
    function test_renounceGovernorRoleProposal_revertsAtExecution() public {
        bytes32 proposer = timelock.PROPOSER_ROLE();
        uint256 id = _passAndQueue(
            address(timelock), abi.encodeCall(timelock.renounceRole, (proposer, address(governor)))
        );
        vm.expectRevert("TimelockController: underlying transaction reverted");
        governor.execute(id);
        assertTrue(timelock.hasRole(proposer, address(governor)));
    }
}

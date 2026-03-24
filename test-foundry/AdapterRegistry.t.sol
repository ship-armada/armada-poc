// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the adapter registry in ArmadaGovernor.
// ABOUTME: Covers authorization, deauthorization, full removal, lifecycle, and fuzz properties.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title AdapterRegistryTest — Tests for governance-managed adapter authorization lifecycle
contract AdapterRegistryTest is Test, GovernorDeployHelper {
    // Mirror events from governor for expectEmit
    event AdapterAuthorized(address indexed adapter);
    event AdapterDeauthorized(address indexed adapter);
    event AdapterFullyDeauthorized(address indexed adapter);
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        uint256 voteStart,
        uint256 voteEnd,
        string description
    );

    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public adapter1 = makeAddr("adapter1");
    address public adapter2 = makeAddr("adapter2");
    address public nobody = address(0xBEEF);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
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
        address[] memory whitelist = new address[](3);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = address(governor);
        armToken.initWhitelist(whitelist);

        // Distribute tokens and delegate
        armToken.transfer(alice, TOTAL_SUPPLY * 30 / 100);
        vm.prank(alice);
        armToken.delegate(alice);

        // Advance block so checkpoints are available
        vm.roll(block.number + 1);

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
    }

    // ======== Authorization ========

    function test_authorizeAdapter_setsFlag() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);

        assertTrue(governor.authorizedAdapters(adapter1));
        assertFalse(governor.withdrawOnlyAdapters(adapter1));
    }

    function test_authorizeAdapter_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit AdapterAuthorized(adapter1);

        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);
    }

    function test_authorizeAdapter_revertsIfNotTimelock() public {
        vm.prank(nobody);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.authorizeAdapter(adapter1);
    }

    function test_authorizeAdapter_revertsIfZeroAddress() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: zero address");
        governor.authorizeAdapter(address(0));
    }

    function test_authorizeAdapter_revertsIfAlreadyAuthorized() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: already authorized");
        governor.authorizeAdapter(adapter1);
    }

    // ======== Deauthorization ========

    function test_deauthorizeAdapter_clearsAuthorizedSetsWithdrawOnly() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);

        vm.prank(address(timelock));
        governor.deauthorizeAdapter(adapter1);

        assertFalse(governor.authorizedAdapters(adapter1));
        assertTrue(governor.withdrawOnlyAdapters(adapter1));
    }

    function test_deauthorizeAdapter_emitsEvent() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);

        vm.expectEmit(true, false, false, false);
        emit AdapterDeauthorized(adapter1);

        vm.prank(address(timelock));
        governor.deauthorizeAdapter(adapter1);
    }

    function test_deauthorizeAdapter_revertsIfNotAuthorized() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: not authorized");
        governor.deauthorizeAdapter(adapter1);
    }

    function test_deauthorizeAdapter_revertsIfNotTimelock() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);

        vm.prank(nobody);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.deauthorizeAdapter(adapter1);
    }

    // ======== Full Deauthorization ========

    function test_fullDeauthorizeAdapter_clearsWithdrawOnly() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);
        vm.prank(address(timelock));
        governor.deauthorizeAdapter(adapter1);

        vm.prank(address(timelock));
        governor.fullDeauthorizeAdapter(adapter1);

        assertFalse(governor.authorizedAdapters(adapter1));
        assertFalse(governor.withdrawOnlyAdapters(adapter1));
    }

    function test_fullDeauthorizeAdapter_emitsEvent() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);
        vm.prank(address(timelock));
        governor.deauthorizeAdapter(adapter1);

        vm.expectEmit(true, false, false, false);
        emit AdapterFullyDeauthorized(adapter1);

        vm.prank(address(timelock));
        governor.fullDeauthorizeAdapter(adapter1);
    }

    function test_fullDeauthorizeAdapter_revertsIfNotWithdrawOnly() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: not withdraw-only");
        governor.fullDeauthorizeAdapter(adapter1);
    }

    function test_fullDeauthorizeAdapter_revertsIfStillAuthorized() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: not withdraw-only");
        governor.fullDeauthorizeAdapter(adapter1);
    }

    function test_fullDeauthorizeAdapter_revertsIfNotTimelock() public {
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);
        vm.prank(address(timelock));
        governor.deauthorizeAdapter(adapter1);

        vm.prank(nobody);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.fullDeauthorizeAdapter(adapter1);
    }

    // ======== Lifecycle ========

    function test_fullLifecycle_authorize_deauth_fullDeauth() public {
        // Start: neither flag set
        assertFalse(governor.authorizedAdapters(adapter1));
        assertFalse(governor.withdrawOnlyAdapters(adapter1));

        // Authorize
        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter1);
        assertTrue(governor.authorizedAdapters(adapter1));
        assertFalse(governor.withdrawOnlyAdapters(adapter1));

        // Deauthorize → withdraw-only
        vm.prank(address(timelock));
        governor.deauthorizeAdapter(adapter1);
        assertFalse(governor.authorizedAdapters(adapter1));
        assertTrue(governor.withdrawOnlyAdapters(adapter1));

        // Full deauthorize → clean slate
        vm.prank(address(timelock));
        governor.fullDeauthorizeAdapter(adapter1);
        assertFalse(governor.authorizedAdapters(adapter1));
        assertFalse(governor.withdrawOnlyAdapters(adapter1));
    }

    function test_reauthorizeAfterFullDeauth() public {
        // Full lifecycle
        vm.startPrank(address(timelock));
        governor.authorizeAdapter(adapter1);
        governor.deauthorizeAdapter(adapter1);
        governor.fullDeauthorizeAdapter(adapter1);

        // Re-authorize works
        governor.authorizeAdapter(adapter1);
        vm.stopPrank();

        assertTrue(governor.authorizedAdapters(adapter1));
        assertFalse(governor.withdrawOnlyAdapters(adapter1));
    }

    function test_multipleAdaptersIndependent() public {
        vm.startPrank(address(timelock));

        // Authorize both
        governor.authorizeAdapter(adapter1);
        governor.authorizeAdapter(adapter2);

        // Deauthorize only adapter1
        governor.deauthorizeAdapter(adapter1);
        vm.stopPrank();

        // adapter1 is withdraw-only, adapter2 still authorized
        assertFalse(governor.authorizedAdapters(adapter1));
        assertTrue(governor.withdrawOnlyAdapters(adapter1));
        assertTrue(governor.authorizedAdapters(adapter2));
        assertFalse(governor.withdrawOnlyAdapters(adapter2));
    }

    // ======== Proposal Classification ========

    function test_authorizeAdapterNotClassifiedAsExtended() public {
        // authorizeAdapter selector should NOT be in extendedSelectors
        bytes4 selector = governor.authorizeAdapter.selector;
        assertFalse(governor.extendedSelectors(selector));
    }

    function test_deauthorizeAdapterNotClassifiedAsExtended() public {
        bytes4 selector = governor.deauthorizeAdapter.selector;
        assertFalse(governor.extendedSelectors(selector));
    }

    function test_fullDeauthorizeAdapterNotClassifiedAsExtended() public {
        bytes4 selector = governor.fullDeauthorizeAdapter.selector;
        assertFalse(governor.extendedSelectors(selector));
    }

    // ======== Fuzz ========

    function testFuzz_authorizeAdapter(address adapter) public {
        vm.assume(adapter != address(0));

        vm.prank(address(timelock));
        governor.authorizeAdapter(adapter);

        assertTrue(governor.authorizedAdapters(adapter));
        assertFalse(governor.withdrawOnlyAdapters(adapter));
    }

    function testFuzz_lifecycleInvariant(address adapter) public {
        vm.assume(adapter != address(0));

        // At no point should both flags be true simultaneously
        assertFalse(governor.authorizedAdapters(adapter) && governor.withdrawOnlyAdapters(adapter));

        vm.startPrank(address(timelock));

        governor.authorizeAdapter(adapter);
        assertFalse(governor.authorizedAdapters(adapter) && governor.withdrawOnlyAdapters(adapter));

        governor.deauthorizeAdapter(adapter);
        assertFalse(governor.authorizedAdapters(adapter) && governor.withdrawOnlyAdapters(adapter));

        governor.fullDeauthorizeAdapter(adapter);
        assertFalse(governor.authorizedAdapters(adapter) && governor.withdrawOnlyAdapters(adapter));

        vm.stopPrank();
    }
}

// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for the standalone AdapterRegistry contract.
// ABOUTME: Covers authorization, deauthorization, full removal, lifecycle, and fuzz properties.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/AdapterRegistry.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title AdapterRegistryTest — Tests for standalone adapter authorization lifecycle
contract AdapterRegistryTest is Test {
    // Mirror events from registry for expectEmit
    event AdapterAuthorized(address indexed adapter);
    event AdapterDeauthorized(address indexed adapter);
    event AdapterFullyDeauthorized(address indexed adapter);

    AdapterRegistry public registry;
    TimelockController public timelock;

    address public deployer = address(this);
    address public adapter1 = makeAddr("adapter1");
    address public adapter2 = makeAddr("adapter2");
    address public nobody = address(0xBEEF);

    uint256 constant TWO_DAYS = 2 days;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy standalone registry owned by timelock
        registry = new AdapterRegistry(address(timelock));
    }

    // ======== Authorization ========

    function test_authorizeAdapter_setsFlag() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);

        assertTrue(registry.authorizedAdapters(adapter1));
        assertFalse(registry.withdrawOnlyAdapters(adapter1));
    }

    function test_authorizeAdapter_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit AdapterAuthorized(adapter1);

        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);
    }

    function test_authorizeAdapter_revertsIfNotTimelock() public {
        vm.prank(nobody);
        vm.expectRevert("AdapterRegistry: not timelock");
        registry.authorizeAdapter(adapter1);
    }

    function test_authorizeAdapter_revertsIfZeroAddress() public {
        vm.prank(address(timelock));
        vm.expectRevert("AdapterRegistry: zero address");
        registry.authorizeAdapter(address(0));
    }

    function test_authorizeAdapter_revertsIfAlreadyAuthorized() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);

        vm.prank(address(timelock));
        vm.expectRevert("AdapterRegistry: already authorized");
        registry.authorizeAdapter(adapter1);
    }

    // ======== Deauthorization ========

    function test_deauthorizeAdapter_clearsAuthorizedSetsWithdrawOnly() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);

        vm.prank(address(timelock));
        registry.deauthorizeAdapter(adapter1);

        assertFalse(registry.authorizedAdapters(adapter1));
        assertTrue(registry.withdrawOnlyAdapters(adapter1));
    }

    function test_deauthorizeAdapter_emitsEvent() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);

        vm.expectEmit(true, false, false, false);
        emit AdapterDeauthorized(adapter1);

        vm.prank(address(timelock));
        registry.deauthorizeAdapter(adapter1);
    }

    function test_deauthorizeAdapter_revertsIfNotAuthorized() public {
        vm.prank(address(timelock));
        vm.expectRevert("AdapterRegistry: not authorized");
        registry.deauthorizeAdapter(adapter1);
    }

    function test_deauthorizeAdapter_revertsIfNotTimelock() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);

        vm.prank(nobody);
        vm.expectRevert("AdapterRegistry: not timelock");
        registry.deauthorizeAdapter(adapter1);
    }

    // ======== Full Deauthorization ========

    function test_fullDeauthorizeAdapter_clearsWithdrawOnly() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);
        vm.prank(address(timelock));
        registry.deauthorizeAdapter(adapter1);

        vm.prank(address(timelock));
        registry.fullDeauthorizeAdapter(adapter1);

        assertFalse(registry.authorizedAdapters(adapter1));
        assertFalse(registry.withdrawOnlyAdapters(adapter1));
    }

    function test_fullDeauthorizeAdapter_emitsEvent() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);
        vm.prank(address(timelock));
        registry.deauthorizeAdapter(adapter1);

        vm.expectEmit(true, false, false, false);
        emit AdapterFullyDeauthorized(adapter1);

        vm.prank(address(timelock));
        registry.fullDeauthorizeAdapter(adapter1);
    }

    function test_fullDeauthorizeAdapter_revertsIfNotWithdrawOnly() public {
        vm.prank(address(timelock));
        vm.expectRevert("AdapterRegistry: not withdraw-only");
        registry.fullDeauthorizeAdapter(adapter1);
    }

    function test_fullDeauthorizeAdapter_revertsIfStillAuthorized() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);

        vm.prank(address(timelock));
        vm.expectRevert("AdapterRegistry: not withdraw-only");
        registry.fullDeauthorizeAdapter(adapter1);
    }

    function test_fullDeauthorizeAdapter_revertsIfNotTimelock() public {
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);
        vm.prank(address(timelock));
        registry.deauthorizeAdapter(adapter1);

        vm.prank(nobody);
        vm.expectRevert("AdapterRegistry: not timelock");
        registry.fullDeauthorizeAdapter(adapter1);
    }

    // ======== Lifecycle ========

    function test_fullLifecycle_authorize_deauth_fullDeauth() public {
        // Start: neither flag set
        assertFalse(registry.authorizedAdapters(adapter1));
        assertFalse(registry.withdrawOnlyAdapters(adapter1));

        // Authorize
        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter1);
        assertTrue(registry.authorizedAdapters(adapter1));
        assertFalse(registry.withdrawOnlyAdapters(adapter1));

        // Deauthorize → withdraw-only
        vm.prank(address(timelock));
        registry.deauthorizeAdapter(adapter1);
        assertFalse(registry.authorizedAdapters(adapter1));
        assertTrue(registry.withdrawOnlyAdapters(adapter1));

        // Full deauthorize → clean slate
        vm.prank(address(timelock));
        registry.fullDeauthorizeAdapter(adapter1);
        assertFalse(registry.authorizedAdapters(adapter1));
        assertFalse(registry.withdrawOnlyAdapters(adapter1));
    }

    function test_reauthorizeAfterFullDeauth() public {
        // Full lifecycle
        vm.startPrank(address(timelock));
        registry.authorizeAdapter(adapter1);
        registry.deauthorizeAdapter(adapter1);
        registry.fullDeauthorizeAdapter(adapter1);

        // Re-authorize works
        registry.authorizeAdapter(adapter1);
        vm.stopPrank();

        assertTrue(registry.authorizedAdapters(adapter1));
        assertFalse(registry.withdrawOnlyAdapters(adapter1));
    }

    function test_multipleAdaptersIndependent() public {
        vm.startPrank(address(timelock));

        // Authorize both
        registry.authorizeAdapter(adapter1);
        registry.authorizeAdapter(adapter2);

        // Deauthorize only adapter1
        registry.deauthorizeAdapter(adapter1);
        vm.stopPrank();

        // adapter1 is withdraw-only, adapter2 still authorized
        assertFalse(registry.authorizedAdapters(adapter1));
        assertTrue(registry.withdrawOnlyAdapters(adapter1));
        assertTrue(registry.authorizedAdapters(adapter2));
        assertFalse(registry.withdrawOnlyAdapters(adapter2));
    }

    // ======== Fuzz ========

    function testFuzz_authorizeAdapter(address adapter) public {
        vm.assume(adapter != address(0));

        vm.prank(address(timelock));
        registry.authorizeAdapter(adapter);

        assertTrue(registry.authorizedAdapters(adapter));
        assertFalse(registry.withdrawOnlyAdapters(adapter));
    }

    function testFuzz_lifecycleInvariant(address adapter) public {
        vm.assume(adapter != address(0));

        // At no point should both flags be true simultaneously
        assertFalse(registry.authorizedAdapters(adapter) && registry.withdrawOnlyAdapters(adapter));

        vm.startPrank(address(timelock));

        registry.authorizeAdapter(adapter);
        assertFalse(registry.authorizedAdapters(adapter) && registry.withdrawOnlyAdapters(adapter));

        registry.deauthorizeAdapter(adapter);
        assertFalse(registry.authorizedAdapters(adapter) && registry.withdrawOnlyAdapters(adapter));

        registry.fullDeauthorizeAdapter(adapter);
        assertFalse(registry.authorizedAdapters(adapter) && registry.withdrawOnlyAdapters(adapter));

        vm.stopPrank();
    }
}

// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for event emissions on setExcludedAddresses and clearDeployer.
// ABOUTME: Verifies these governance lifecycle functions emit auditable events.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title GovernorEventGapsTest — Tests for event emissions on previously-unlogged state changes
contract GovernorEventGapsTest is Test, GovernorDeployHelper {
    // Mirror events from governor for expectEmit
    event ExcludedAddressesSet(address[] addresses);
    event DeployerCleared(address indexed previousDeployer);

    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);

    function setUp() public {
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(2 days, proposers, executors, deployer);

        armToken = new ArmadaToken(deployer, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock));

        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );
    }

    // WHY: setExcludedAddresses modifies quorum denominator calculations — a critical
    // governance parameter. Without an event, off-chain monitors and UIs cannot detect
    // when excluded addresses are registered, making governance state opaque.
    function test_setExcludedAddresses_emitsEvent() public {
        address[] memory addrs = new address[](2);
        addrs[0] = address(0xCafe);
        addrs[1] = address(0xBabe);

        vm.expectEmit(false, false, false, true, address(governor));
        emit ExcludedAddressesSet(addrs);

        governor.setExcludedAddresses(addrs);
    }

    // WHY: clearDeployer permanently revokes deployer privileges on the governor.
    // This is a one-way security lifecycle event — once cleared, no more deployer-gated
    // calls can be made. An event provides an auditable on-chain record of when
    // the deployer role was renounced.
    function test_clearDeployer_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(governor));
        emit DeployerCleared(deployer);

        governor.clearDeployer();
    }

    // WHY: setExcludedAddresses is a one-time setter that locks permanently. This test
    // verifies the lock still works correctly after we added event emission — a second
    // call must revert with Gov_AlreadyLocked to prevent re-registration attacks.
    function test_setExcludedAddresses_revertsAfterLocked() public {
        address[] memory addrs = new address[](1);
        addrs[0] = address(0xCafe);

        governor.setExcludedAddresses(addrs);

        vm.expectRevert(ArmadaGovernor.Gov_AlreadyLocked.selector);
        governor.setExcludedAddresses(addrs);
    }

    // WHY: _initProposal sums balanceOf across the excluded list to derive
    // excludedBalance. A duplicate would double-count its balance and lower the
    // quorum threshold below the spec-defined value. excludedAddressesLocked makes
    // any bootstrap mistake permanent without a UUPS upgrade, so detection happens
    // at registration time.
    function test_setExcludedAddresses_revertsOnDuplicate() public {
        address[] memory addrs = new address[](2);
        addrs[0] = address(0xCafe);
        addrs[1] = address(0xCafe);

        vm.expectRevert(ArmadaGovernor.Gov_DuplicateExcludedAddress.selector);
        governor.setExcludedAddresses(addrs);
    }

    // WHY: Pin the multi-entry duplicate-anywhere case (not just adjacent). The
    // n^2 inner loop must catch a duplicate against any earlier entry, not just
    // the immediately preceding one.
    function test_setExcludedAddresses_revertsOnNonAdjacentDuplicate() public {
        address[] memory addrs = new address[](3);
        addrs[0] = address(0xCafe);
        addrs[1] = address(0xBabe);
        addrs[2] = address(0xCafe); // duplicate of addrs[0], not addrs[1]

        vm.expectRevert(ArmadaGovernor.Gov_DuplicateExcludedAddress.selector);
        governor.setExcludedAddresses(addrs);
    }

    // WHY: Regression guard — happy path with unique addresses must still register
    // and lock cleanly after the duplicate-detection loop was added.
    function test_setExcludedAddresses_acceptsUniqueAddresses() public {
        address[] memory addrs = new address[](3);
        addrs[0] = address(0xCafe);
        addrs[1] = address(0xBabe);
        addrs[2] = address(0xFace);

        governor.setExcludedAddresses(addrs);
        assertTrue(governor.excludedAddressesLocked());
    }
}

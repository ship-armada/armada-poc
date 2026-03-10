// ABOUTME: Foundry tests for TreasurySteward target whitelist and minimum action delay.
// ABOUTME: Covers issue #22: unrestricted proposeAction target + insufficient veto window.

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

/// @title StewardSecurityTest — Tests for target whitelist and minimum action delay
/// @dev Covers fixes for issue #22
contract StewardSecurityTest is Test {
    // Re-declare events for vm.expectEmit
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);
    event ActionDelayUpdated(uint256 oldDelay, uint256 newDelay);

    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    TreasurySteward public steward;

    address public stewardPerson = address(0xDA7E);
    address public attacker = address(0xBAD);

    // Governor ParameterChange timing: 2d + 5d + 2d = 9 days
    // Min delay = 9 days * 120% = 10.8 days = 933120 seconds
    uint256 constant EXPECTED_MIN_DELAY = (2 days + 5 days + 2 days) * 12000 / 10000;
    // Use exactly the min delay for test setup
    uint256 constant TEST_ACTION_DELAY = EXPECTED_MIN_DELAY;

    function setUp() public {
        // Deploy ARM token
        armToken = new ArmadaToken(address(this));

        // Deploy VotingLocker
        locker = new VotingLocker(address(armToken));

        // Deploy TimelockController (this test contract acts as admin)
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(
            2 days,
            proposers,
            executors,
            address(this)
        );

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock));

        // Deploy governor
        governor = new ArmadaGovernor(
            address(locker),
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );

        // Deploy steward with governor reference and valid delay
        steward = new TreasurySteward(
            address(this),  // this contract acts as timelock for test convenience
            address(treasury),
            address(governor),
            TEST_ACTION_DELAY
        );

        // Elect steward person
        steward.electSteward(stewardPerson);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Constructor validation
    // ══════════════════════════════════════════════════════════════════════

    function test_constructor_rejectsZeroGovernor() public {
        vm.expectRevert("TreasurySteward: zero governor");
        new TreasurySteward(
            address(this),
            address(treasury),
            address(0),
            TEST_ACTION_DELAY
        );
    }

    function test_constructor_rejectsDelayBelowMin() public {
        vm.expectRevert("TreasurySteward: delay below governance cycle");
        new TreasurySteward(
            address(this),
            address(treasury),
            address(governor),
            1 days // way below the ~10.8 day minimum
        );
    }

    function test_constructor_whitelistsTreasury() public view {
        assertTrue(steward.allowedTargets(address(treasury)));
    }

    function test_constructor_acceptsExactMinDelay() public {
        // Should not revert with exact minimum
        TreasurySteward s = new TreasurySteward(
            address(this),
            address(treasury),
            address(governor),
            EXPECTED_MIN_DELAY
        );
        assertEq(s.actionDelay(), EXPECTED_MIN_DELAY);
    }

    // ══════════════════════════════════════════════════════════════════════
    // minActionDelay derivation
    // ══════════════════════════════════════════════════════════════════════

    function test_minActionDelay_derivedFromGovernor() public view {
        uint256 minDelay = steward.minActionDelay();
        // ParameterChange: 2d voting delay + 5d voting period + 2d execution delay = 9d
        // 9 days * 120% = 10.8 days
        assertEq(minDelay, EXPECTED_MIN_DELAY);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Target whitelist
    // ══════════════════════════════════════════════════════════════════════

    function test_proposeAction_rejectsNonWhitelistedTarget() public {
        address badTarget = address(0xDEAD);
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(badTarget, "", 0);
    }

    function test_proposeAction_acceptsWhitelistedTarget() public {
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(address(treasury), "", 0);
        assertEq(actionId, 1);
    }

    function test_addAllowedTarget_onlyTimelock() public {
        address newTarget = address(0xBEEF);
        vm.prank(attacker);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.addAllowedTarget(newTarget);
    }

    function test_addAllowedTarget_success() public {
        address newTarget = address(0xBEEF);
        steward.addAllowedTarget(newTarget);
        assertTrue(steward.allowedTargets(newTarget));
    }

    function test_addAllowedTarget_rejectsZeroAddress() public {
        vm.expectRevert("TreasurySteward: zero target");
        steward.addAllowedTarget(address(0));
    }

    function test_addAllowedTarget_rejectsDuplicate() public {
        vm.expectRevert("TreasurySteward: already allowed");
        steward.addAllowedTarget(address(treasury));
    }

    function test_addAllowedTarget_emitsEvent() public {
        address newTarget = address(0xBEEF);
        vm.expectEmit(true, false, false, false);
        emit TargetAdded(newTarget);
        steward.addAllowedTarget(newTarget);
    }

    function test_removeAllowedTarget_onlyTimelock() public {
        address target = address(0xBEEF);
        steward.addAllowedTarget(target);

        vm.prank(attacker);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.removeAllowedTarget(target);
    }

    function test_removeAllowedTarget_cannotRemoveTreasury() public {
        vm.expectRevert("TreasurySteward: cannot remove treasury");
        steward.removeAllowedTarget(address(treasury));
    }

    function test_removeAllowedTarget_rejectsNonAllowed() public {
        vm.expectRevert("TreasurySteward: not allowed");
        steward.removeAllowedTarget(address(0xBEEF));
    }

    function test_removeAllowedTarget_success() public {
        address target = address(0xBEEF);
        steward.addAllowedTarget(target);
        assertTrue(steward.allowedTargets(target));

        steward.removeAllowedTarget(target);
        assertFalse(steward.allowedTargets(target));
    }

    function test_removeAllowedTarget_emitsEvent() public {
        address target = address(0xBEEF);
        steward.addAllowedTarget(target);

        vm.expectEmit(true, false, false, false);
        emit TargetRemoved(target);
        steward.removeAllowedTarget(target);
    }

    function test_proposeAction_failsAfterTargetRemoved() public {
        address target = address(0xBEEF);
        steward.addAllowedTarget(target);

        // Can propose to new target
        vm.prank(stewardPerson);
        steward.proposeAction(target, "", 0);

        // Remove target
        steward.removeAllowedTarget(target);

        // Can no longer propose to removed target
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(target, "", 0);
    }

    function test_executeAction_rejectsRemovedTarget() public {
        address target = address(0xBEEF);
        steward.addAllowedTarget(target);

        // Steward proposes action targeting the new target
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(target, "", 0);

        // Governance removes the target during the veto window
        steward.removeAllowedTarget(target);

        // Warp past delay
        vm.warp(block.timestamp + TEST_ACTION_DELAY + 1);

        // Execution should fail — target was removed after proposal
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.executeAction(actionId);
    }

    // ══════════════════════════════════════════════════════════════════════
    // setActionDelay with minimum enforcement
    // ══════════════════════════════════════════════════════════════════════

    function test_setActionDelay_rejectsBelowMin() public {
        vm.expectRevert("TreasurySteward: delay below governance cycle");
        steward.setActionDelay(1 days);
    }

    function test_setActionDelay_acceptsAboveMin() public {
        uint256 newDelay = EXPECTED_MIN_DELAY + 1 days;
        steward.setActionDelay(newDelay);
        assertEq(steward.actionDelay(), newDelay);
    }

    function test_setActionDelay_acceptsExactMin() public {
        steward.setActionDelay(EXPECTED_MIN_DELAY);
        assertEq(steward.actionDelay(), EXPECTED_MIN_DELAY);
    }

    function test_setActionDelay_emitsEvent() public {
        uint256 newDelay = EXPECTED_MIN_DELAY + 1 days;
        vm.expectEmit(false, false, false, true);
        emit ActionDelayUpdated(TEST_ACTION_DELAY, newDelay);
        steward.setActionDelay(newDelay);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fuzz: action delay always >= min
    // ══════════════════════════════════════════════════════════════════════

    function testFuzz_constructor_rejectsDelayBelowMin(uint256 delay) public {
        uint256 minDelay = steward.minActionDelay();
        delay = bound(delay, 0, minDelay - 1);

        vm.expectRevert("TreasurySteward: delay below governance cycle");
        new TreasurySteward(
            address(this),
            address(treasury),
            address(governor),
            delay
        );
    }

    function testFuzz_setActionDelay_rejectsBelowMin(uint256 delay) public {
        uint256 minDelay = steward.minActionDelay();
        delay = bound(delay, 0, minDelay - 1);

        vm.expectRevert("TreasurySteward: delay below governance cycle");
        steward.setActionDelay(delay);
    }

    function testFuzz_proposeAction_rejectsArbitraryTarget(address target) public {
        // Any target that isn't whitelisted should be rejected
        vm.assume(!steward.allowedTargets(target));

        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: target not allowed");
        steward.proposeAction(target, "", 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Issue #38: New steward cannot execute previous steward's actions
    // ══════════════════════════════════════════════════════════════════════

    function test_executeAction_rejectsDifferentStewardProposal() public {
        // stewardPerson proposes an action
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(address(treasury), "", 0);

        // Elect a new steward (this contract acts as timelock)
        address newSteward = address(0xCAFE);
        steward.electSteward(newSteward);
        assertEq(steward.currentSteward(), newSteward);

        // Warp past the action delay
        vm.warp(block.timestamp + TEST_ACTION_DELAY + 1);

        // New steward tries to execute old steward's action — should revert
        vm.prank(newSteward);
        vm.expectRevert("TreasurySteward: not proposed by current steward");
        steward.executeAction(actionId);
    }

    function test_executeAction_allowsReElectedSteward() public {
        // stewardPerson proposes an action
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(address(treasury), "", 0);

        // Re-elect the same steward (new term, same address)
        steward.electSteward(stewardPerson);

        // Warp past the action delay
        vm.warp(block.timestamp + TEST_ACTION_DELAY + 1);

        // Same steward should still be able to execute their own action
        vm.prank(stewardPerson);
        // The call may fail for unrelated reasons (empty data to treasury),
        // but it should NOT fail with "not proposed by current steward"
        try steward.executeAction(actionId) {
            // Success — proposedBy check passed
        } catch (bytes memory reason) {
            assertTrue(
                keccak256(reason) != keccak256(abi.encodeWithSignature("Error(string)", "TreasurySteward: not proposed by current steward")),
                "Should not revert with proposedBy check for re-elected steward"
            );
        }
    }

    function testFuzz_executeAction_rejectsCrossStewardAction(address newStewardAddr) public {
        vm.assume(newStewardAddr != stewardPerson);
        vm.assume(newStewardAddr != address(0));

        // Current steward proposes
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(address(treasury), "", 0);

        // Elect different steward
        steward.electSteward(newStewardAddr);

        vm.warp(block.timestamp + TEST_ACTION_DELAY + 1);

        // New steward tries to execute — should fail
        vm.prank(newStewardAddr);
        vm.expectRevert("TreasurySteward: not proposed by current steward");
        steward.executeAction(actionId);
    }

    // ══════════════════════════════════════════════════════════════════════
    // End-to-end: propose + execute with realistic delay
    // ══════════════════════════════════════════════════════════════════════

    function test_executeAction_afterRealisticDelay() public {
        // Set treasury steward on the treasury so executeAction → stewardSpend works
        // (treasury is owned by timelock, but in this test `this` is acting as timelock
        //  for the steward — the treasury itself has address(timelock) as owner)
        // We use a simple call to treasury target that won't revert (empty data)
        vm.prank(stewardPerson);
        uint256 actionId = steward.proposeAction(address(treasury), "", 0);

        // Cannot execute before delay
        vm.prank(stewardPerson);
        vm.expectRevert("TreasurySteward: delay not elapsed");
        steward.executeAction(actionId);

        // Warp past the realistic delay
        vm.warp(block.timestamp + TEST_ACTION_DELAY + 1);

        // Now execution succeeds (empty call to treasury — will revert because no fallback,
        // but that's fine — we're testing the delay enforcement, not the treasury call)
        // Actually, empty data + 0 value to a contract without receive/fallback may succeed
        // as a no-op in some cases. Let's just check it doesn't revert with "delay not elapsed"
        vm.prank(stewardPerson);
        // The call to treasury with empty data may or may not succeed depending on
        // whether treasury has a fallback. We just verify the delay check passes.
        try steward.executeAction(actionId) {
            // Delay check passed and action executed
        } catch (bytes memory reason) {
            // If it reverts, it should NOT be because of the delay check
            assertTrue(
                keccak256(reason) != keccak256(abi.encodeWithSignature("Error(string)", "TreasurySteward: delay not elapsed")),
                "Should not revert with delay error after sufficient time"
            );
        }
    }
}

// ABOUTME: Foundry tests for TreasurySteward identity management: election, removal, term, and access control.
// ABOUTME: Validates the slimmed-down steward contract that tracks identity only (proposals flow through governor).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/TreasurySteward.sol";
import "../contracts/governance/IArmadaGovernance.sol";

/// @title StewardSecurityTest — Identity management tests for slimmed TreasurySteward
contract StewardSecurityTest is Test {
    // Re-declare events for vm.expectEmit
    event StewardElected(address indexed steward, uint256 termStart, uint256 termEnd);
    event StewardRemoved(address indexed steward);

    TreasurySteward public steward;

    address public timelockAddr = address(0x71);
    address public stewardPerson = address(0xDA7E);
    address public attacker = address(0xBAD);

    function setUp() public {
        steward = new TreasurySteward(
            address(this)  // this contract acts as timelock for test convenience
        );

        // Elect steward person
        steward.electSteward(stewardPerson);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Constructor validation
    // ══════════════════════════════════════════════════════════════════════

    function test_constructor_rejectsZeroTimelock() public {
        vm.expectRevert("TreasurySteward: zero timelock");
        new TreasurySteward(address(0));
    }

    // ══════════════════════════════════════════════════════════════════════
    // Election
    // ══════════════════════════════════════════════════════════════════════

    function test_electSteward_onlyTimelock() public {
        vm.prank(attacker);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.electSteward(address(0xCAFE));
    }

    function test_electSteward_rejectsZeroAddress() public {
        vm.expectRevert("TreasurySteward: zero address");
        steward.electSteward(address(0));
    }

    function test_electSteward_success() public {
        address newSteward = address(0xCAFE);
        steward.electSteward(newSteward);
        assertEq(steward.currentSteward(), newSteward);
        assertTrue(steward.isStewardActive());
    }

    function test_electSteward_emitsEvent() public {
        address newSteward = address(0xCAFE);
        vm.expectEmit(true, false, false, true);
        emit StewardElected(newSteward, block.timestamp, block.timestamp + 180 days);
        steward.electSteward(newSteward);
    }

    function test_electSteward_replacesExisting() public {
        address newSteward = address(0xCAFE);
        steward.electSteward(newSteward);
        assertEq(steward.currentSteward(), newSteward);

        // Original steward is no longer current
        assertTrue(steward.currentSteward() != stewardPerson);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Removal
    // ══════════════════════════════════════════════════════════════════════

    function test_removeSteward_onlyTimelock() public {
        vm.prank(attacker);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.removeSteward();
    }

    function test_removeSteward_success() public {
        steward.removeSteward();
        assertEq(steward.currentSteward(), address(0));
        assertFalse(steward.isStewardActive());
    }

    function test_removeSteward_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit StewardRemoved(stewardPerson);
        steward.removeSteward();
    }

    // ══════════════════════════════════════════════════════════════════════
    // Term tracking
    // ══════════════════════════════════════════════════════════════════════

    function test_isStewardActive_trueWithinTerm() public view {
        assertTrue(steward.isStewardActive());
    }

    function test_isStewardActive_falseAfterTermExpires() public {
        vm.warp(block.timestamp + 180 days + 1);
        assertFalse(steward.isStewardActive());
    }

    function test_isStewardActive_falseAfterRemoval() public {
        steward.removeSteward();
        assertFalse(steward.isStewardActive());
    }

    function test_termEnd_returnsZeroWhenNoSteward() public {
        steward.removeSteward();
        assertEq(steward.termEnd(), 0);
    }

    function test_termEnd_returnsCorrectValue() public view {
        assertEq(steward.termEnd(), steward.termStart() + 180 days);
    }

    function test_reElection_resetsTerm() public {
        uint256 originalTermStart = steward.termStart();

        // Warp forward 90 days (mid-term)
        vm.warp(block.timestamp + 90 days);

        // Re-elect same person
        steward.electSteward(stewardPerson);

        // Term start should be updated
        assertTrue(steward.termStart() > originalTermStart);
        assertTrue(steward.isStewardActive());
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fuzz: election access control
    // ══════════════════════════════════════════════════════════════════════

    function testFuzz_electSteward_rejectsNonTimelock(address caller) public {
        vm.assume(caller != address(this)); // this contract acts as timelock

        vm.prank(caller);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.electSteward(address(0xCAFE));
    }

    function testFuzz_removeSteward_rejectsNonTimelock(address caller) public {
        vm.assume(caller != address(this));

        vm.prank(caller);
        vm.expectRevert("TreasurySteward: not timelock");
        steward.removeSteward();
    }
}

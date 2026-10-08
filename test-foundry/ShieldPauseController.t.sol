// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ShieldPauseController — disabled (zero-duration) SC pause and wind-down modes.
// ABOUTME: Covers SC authorization via governor, same-block pause expiry, timelock unpause, and the post-wind-down budget.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ShieldPauseController.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./helpers/GovernorDeployHelper.sol";

contract ShieldPauseControllerTest is Test, GovernorDeployHelper {
    // Mirror events for expectEmit
    event ShieldsPaused(address indexed securityCouncil, uint256 expiry);
    event ShieldsUnpaused(address indexed caller);
    event WindDownContractSet(address indexed windDownContract);
    event WindDownActivated();

    ShieldPauseController public pauseController;
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public securityCouncil = address(0x5C5C);
    address public windDown = address(0xD00D);
    address public randomUser = address(0xCAFE);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant MAX_PAUSE = 14 days;
    uint256 constant TWENTY_FOUR_HOURS = 24 hours;

    function setUp() public {
        // Deploy governance stack
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

        // Set SC on governor
        vm.prank(address(timelock));
        governor.setSecurityCouncil(securityCouncil);

        // Deploy shield pause controller
        pauseController = new ShieldPauseController(address(governor), address(timelock));
    }

    // ======== Basic Pause / Unpause ========

    // WHY: MAX_PAUSE_DURATION is zero, so the SC pause is disabled — the call succeeds and
    // emits, but the pause expires in the block it is made and never pauses shields.
    function test_SC_pauseIsNoOp() public {
        vm.prank(securityCouncil);
        vm.expectEmit(true, false, false, true);
        emit ShieldsPaused(securityCouncil, block.timestamp);
        pauseController.pauseShields();

        assertFalse(pauseController.shieldsPaused());
        assertFalse(pauseController.emergencyPaused());
        assertEq(pauseController.pauseExpiry(), block.timestamp);
    }

    // WHY: with a zero duration no pause is ever active, so repeated calls never hit the
    // "already paused" guard and never pause shields.
    function test_SC_canCallPauseRepeatedly() public {
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertFalse(pauseController.shieldsPaused());
    }

    function test_nonSC_cannotPause() public {
        vm.prank(randomUser);
        vm.expectRevert("ShieldPauseController: not SC");
        pauseController.pauseShields();
    }

    function test_ejectedSC_cannotPause() public {
        // Eject SC by setting to address(0)
        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0));

        vm.prank(securityCouncil);
        vm.expectRevert("ShieldPauseController: not SC");
        pauseController.pauseShields();
    }

    // WHY: a zero-duration pause is never active, so there is nothing for governance to lift.
    function test_timelockCannotUnpauseAfterNoOpPause() public {
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        vm.prank(address(timelock));
        vm.expectRevert("ShieldPauseController: not paused");
        pauseController.unpauseShields();
    }

    function test_timelockCannotUnpauseWhenNotPaused() public {
        vm.prank(address(timelock));
        vm.expectRevert("ShieldPauseController: not paused");
        pauseController.unpauseShields();
    }

    function test_nonTimelockCannotUnpause() public {
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        vm.prank(randomUser);
        vm.expectRevert("ShieldPauseController: not timelock");
        pauseController.unpauseShields();
    }

    // ======== SC Change Propagation ========

    function test_governorSCChangeAffectsWhoCanPause() public {
        address newSC = address(0x5C5C5C);

        // Change SC on governor
        vm.prank(address(timelock));
        governor.setSecurityCouncil(newSC);

        // Old SC cannot pause
        vm.prank(securityCouncil);
        vm.expectRevert("ShieldPauseController: not SC");
        pauseController.pauseShields();

        // New SC is authorized (the call succeeds), but the pause has no effect
        vm.prank(newSC);
        pauseController.pauseShields();
        assertFalse(pauseController.shieldsPaused());
    }

    // ======== Wind-Down Contract Setup ========

    function test_setWindDownContract() public {
        vm.prank(address(timelock));
        vm.expectEmit(true, false, false, false);
        emit WindDownContractSet(windDown);
        pauseController.setWindDownContract(windDown);

        assertEq(pauseController.windDownContract(), windDown);
        assertTrue(pauseController.windDownContractSet());
    }

    function test_setWindDownContract_onlyOnce() public {
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);

        vm.prank(address(timelock));
        vm.expectRevert("ShieldPauseController: wind-down already set");
        pauseController.setWindDownContract(address(0x999));
    }

    function test_setWindDownContract_onlyTimelock() public {
        vm.prank(randomUser);
        vm.expectRevert("ShieldPauseController: not timelock");
        pauseController.setWindDownContract(windDown);
    }

    function test_setWindDownContract_rejectsZero() public {
        vm.prank(address(timelock));
        vm.expectRevert("ShieldPauseController: zero address");
        pauseController.setWindDownContract(address(0));
    }

    // ======== Wind-Down Activation ========

    function test_setWindDownActive() public {
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);

        vm.prank(windDown);
        vm.expectEmit(false, false, false, false);
        emit WindDownActivated();
        pauseController.setWindDownActive();

        assertTrue(pauseController.windDownActive());
    }

    function test_setWindDownActive_onlyWindDownContract() public {
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);

        vm.prank(randomUser);
        vm.expectRevert("ShieldPauseController: not wind-down contract");
        pauseController.setWindDownActive();
    }

    function test_setWindDownActive_cannotCallTwice() public {
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);

        vm.prank(windDown);
        pauseController.setWindDownActive();

        vm.prank(windDown);
        vm.expectRevert("ShieldPauseController: wind-down already active");
        pauseController.setWindDownActive();
    }

    // ======== Post-Wind-Down Pause Behavior (Task 4.4) ========

    function test_postWindDown_singlePauseAllowed() public {
        // Setup wind-down
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        // SC can call pause once; shields stay paused by wind-down, but the emergency
        // pause (which would also block unshields) never becomes active.
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.shieldsPaused());
        assertFalse(pauseController.emergencyPaused());
        assertTrue(pauseController.windDownPauseUsed());
    }

    function test_postWindDown_shieldsPermanentlyPaused() public {
        // Setup wind-down
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        // Shields permanently paused without any SC action
        assertTrue(pauseController.shieldsPaused());

        // Still paused after arbitrary time
        vm.warp(block.timestamp + 365 days);
        assertTrue(pauseController.shieldsPaused());
    }

    function test_postWindDown_secondPauseReverts() public {
        // Setup wind-down
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        // First SC pause succeeds
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        // After SC pause expiry, shields remain paused due to wind-down
        vm.warp(block.timestamp + TWENTY_FOUR_HOURS);
        assertTrue(pauseController.shieldsPaused());

        // Second SC pause reverts
        vm.prank(securityCouncil);
        vm.expectRevert("ShieldPauseController: post-wind-down pause already used");
        pauseController.pauseShields();
    }

    // WHY: setWindDownActive consumes the post-wind-down budget only when a pre-trigger
    // pause is still active (the bleed-through guard). With a zero duration a pause made
    // even in the same block as the trigger is never active, so nothing bleeds across
    // and no unshield block (emergencyPaused) can occur.
    function test_preTriggerPause_cannotBleedAcrossTrigger() public {
        // Pre-trigger SC pause, in the same block as the trigger
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertFalse(pauseController.shieldsPaused());

        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        assertFalse(pauseController.windDownPauseUsed());
        assertFalse(pauseController.emergencyPaused());
    }

    // WHY: Regression — wind-down with no active pre-trigger pause must leave the
    // single post-trigger pause budget intact. The new bleed-through guard must not
    // over-consume the budget when there's nothing to bleed.
    function test_setWindDownActive_noActivePause_preservesPauseBudget() public {
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        assertFalse(pauseController.windDownPauseUsed());

        // SC can use the full single post-trigger pause.
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.windDownPauseUsed());
    }

    // WHY: A pre-trigger pause that EXPIRED before wind-down trigger must NOT
    // consume the post-trigger budget. Pins the strict-active check (_isPaused
    // must include the timestamp gate, not just _paused alone).
    function test_expiredPreTriggerPause_doesNotConsumeBudget() public {
        // Pre-trigger pause + expire fully
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        vm.warp(block.timestamp + TWENTY_FOUR_HOURS);
        assertFalse(pauseController.shieldsPaused());

        // Wind-down activates AFTER the pause expired
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        // Budget still untouched — SC retains the single post-trigger pause
        assertFalse(pauseController.windDownPauseUsed());
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.windDownPauseUsed());
    }

    function test_preWindDown_unlimitedPauses() public {
        // Multiple pause calls before wind-down; none ever pauses shields
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(securityCouncil);
            pauseController.pauseShields();
            assertFalse(pauseController.shieldsPaused());

            vm.warp(block.timestamp + 1 hours);
            assertFalse(pauseController.shieldsPaused());
        }
    }

    // ======== Edge Cases ========

    function test_shieldsPaused_returnsFalseByDefault() public view {
        assertFalse(pauseController.shieldsPaused());
    }

    function test_MAX_PAUSE_DURATION_isZero() public view {
        assertEq(pauseController.MAX_PAUSE_DURATION(), 0);
    }

    function test_constructorRejectsZeroGovernor() public {
        vm.expectRevert("ShieldPauseController: zero governor");
        new ShieldPauseController(address(0), address(timelock));
    }

    function test_constructorRejectsZeroTimelock() public {
        vm.expectRevert("ShieldPauseController: zero timelock");
        new ShieldPauseController(address(governor), address(0));
    }
}

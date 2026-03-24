// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ShieldPauseController — SC pause, auto-expiry, and post-wind-down behavior.
// ABOUTME: Covers SC authorization via governor, 24h expiry, timelock unpause, and single post-wind-down pause.
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
        treasury = new ArmadaTreasuryGov(address(timelock), deployer, MAX_PAUSE);
        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury),
            deployer,
            MAX_PAUSE
        );

        // Set SC on governor
        vm.prank(address(timelock));
        governor.setSecurityCouncil(securityCouncil);

        // Deploy shield pause controller
        pauseController = new ShieldPauseController(address(governor), address(timelock));
    }

    // ======== Basic Pause / Unpause ========

    function test_SC_canPauseShields() public {
        vm.prank(securityCouncil);
        vm.expectEmit(true, false, false, true);
        emit ShieldsPaused(securityCouncil, block.timestamp + TWENTY_FOUR_HOURS);
        pauseController.pauseShields();

        assertTrue(pauseController.shieldsPaused());
    }

    function test_pauseAutoExpiresAfter24Hours() public {
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.shieldsPaused());

        // Just before expiry — still paused
        vm.warp(block.timestamp + TWENTY_FOUR_HOURS - 1);
        assertTrue(pauseController.shieldsPaused());

        // At expiry — no longer paused
        vm.warp(block.timestamp + 1);
        assertFalse(pauseController.shieldsPaused());
    }

    function test_SC_canRePauseAfterExpiry() public {
        // First pause
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        // Expire
        vm.warp(block.timestamp + TWENTY_FOUR_HOURS);
        assertFalse(pauseController.shieldsPaused());

        // Second pause
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.shieldsPaused());
    }

    function test_SC_cannotPauseWhenAlreadyPaused() public {
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        vm.prank(securityCouncil);
        vm.expectRevert("ShieldPauseController: already paused");
        pauseController.pauseShields();
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

    function test_timelockCanUnpauseEarly() public {
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.shieldsPaused());

        vm.prank(address(timelock));
        vm.expectEmit(true, false, false, false);
        emit ShieldsUnpaused(address(timelock));
        pauseController.unpauseShields();

        assertFalse(pauseController.shieldsPaused());
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

        // New SC can pause
        vm.prank(newSC);
        pauseController.pauseShields();
        assertTrue(pauseController.shieldsPaused());
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

        // SC can pause once
        vm.prank(securityCouncil);
        pauseController.pauseShields();
        assertTrue(pauseController.shieldsPaused());
    }

    function test_postWindDown_secondPauseReverts() public {
        // Setup wind-down
        vm.prank(address(timelock));
        pauseController.setWindDownContract(windDown);
        vm.prank(windDown);
        pauseController.setWindDownActive();

        // First pause
        vm.prank(securityCouncil);
        pauseController.pauseShields();

        // Expire the pause
        vm.warp(block.timestamp + TWENTY_FOUR_HOURS);
        assertFalse(pauseController.shieldsPaused());

        // Second pause reverts
        vm.prank(securityCouncil);
        vm.expectRevert("ShieldPauseController: post-wind-down pause already used");
        pauseController.pauseShields();
    }

    function test_preWindDown_unlimitedPauses() public {
        // Multiple pause/expire cycles before wind-down
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(securityCouncil);
            pauseController.pauseShields();
            assertTrue(pauseController.shieldsPaused());

            vm.warp(block.timestamp + TWENTY_FOUR_HOURS);
            assertFalse(pauseController.shieldsPaused());
        }
    }

    // ======== Edge Cases ========

    function test_shieldsPaused_returnsFalseByDefault() public view {
        assertFalse(pauseController.shieldsPaused());
    }

    function test_MAX_PAUSE_DURATION_is24Hours() public view {
        assertEq(pauseController.MAX_PAUSE_DURATION(), 24 hours);
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

// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ArmadaWindDown — permissionless trigger, governance trigger, and treasury sweeps.
// ABOUTME: Covers trigger conditions, hook activation (token, governor, pause), sweep mechanics, and parameter setters.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaWindDown.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/ShieldPauseController.sol";
import "../contracts/governance/ArmadaRedemption.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock RevenueCounter for testing
contract MockRevenueCounter {
    uint256 public recognizedRevenueUsd;

    function setRevenue(uint256 _revenue) external {
        recognizedRevenueUsd = _revenue;
    }
}

/// @dev Mock ERC20 for treasury balance tests
contract MockUSDCWindDown is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract ArmadaWindDownTest is Test {
    // Mirror events
    event WindDownTriggered(address indexed caller, uint256 timestamp);
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);
    event ETHSwept(address indexed recipient, uint256 amount);
    event RevenueThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event WindDownDeadlineUpdated(uint256 oldDeadline, uint256 newDeadline);

    ArmadaWindDown public windDown;
    ArmadaToken public armToken;
    ArmadaGovernor public governor;
    ArmadaTreasuryGov public treasury;
    ShieldPauseController public pauseController;
    MockRevenueCounter public revenueCounter;
    ArmadaRedemption public redemption;
    TimelockController public timelock;
    MockUSDCWindDown public usdc;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public randomUser = address(0xCAFE);
    address public revenueLock = address(0xABCD);
    address public crowdfund = address(0xCF00);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant MAX_PAUSE = 14 days;
    uint256 constant REVENUE_THRESHOLD = 10_000 * 1e18; // $10k
    uint256 constant WIND_DOWN_DEADLINE = 1_798_761_600; // Dec 31, 2026 (approx)

    function setUp() public {
        // Set block.timestamp to a reasonable starting point
        vm.warp(1_700_000_000); // Nov 2023

        // Deploy governance stack
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        armToken = new ArmadaToken(deployer, address(timelock));
        treasury = new ArmadaTreasuryGov(address(timelock), deployer, MAX_PAUSE);
        governor = new ArmadaGovernor(
            address(armToken),
            payable(address(timelock)),
            address(treasury),
            deployer,
            MAX_PAUSE
        );
        pauseController = new ShieldPauseController(address(governor), address(timelock));
        revenueCounter = new MockRevenueCounter();
        usdc = new MockUSDCWindDown();

        // Deploy redemption (needs ARM token + excluded addresses)
        redemption = new ArmadaRedemption(
            address(armToken),
            address(treasury),
            revenueLock,
            crowdfund
        );

        // Deploy wind-down
        windDown = new ArmadaWindDown(
            address(armToken),
            address(treasury),
            address(governor),
            address(redemption),
            address(pauseController),
            address(revenueCounter),
            address(timelock),
            REVENUE_THRESHOLD,
            WIND_DOWN_DEADLINE
        );

        // Register wind-down on all consumers
        armToken.setWindDownContract(address(windDown));

        vm.startPrank(address(timelock));
        governor.setWindDownContract(address(windDown));
        pauseController.setWindDownContract(address(windDown));
        treasury.setWindDownContract(address(windDown));
        vm.stopPrank();

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));

        // Setup ARM token whitelist
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = address(treasury);
        whitelist[2] = address(governor);
        whitelist[3] = alice;
        armToken.initWhitelist(whitelist);

        // Distribute tokens
        armToken.transfer(address(treasury), TOTAL_SUPPLY * 65 / 100);
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);

        // Fund treasury with USDC
        usdc.mint(address(treasury), 500_000e6);
    }

    // ======== Permissionless Trigger ========

    function test_permissionlessTrigger_succeeds() public {
        // Past deadline, revenue below threshold
        vm.warp(WIND_DOWN_DEADLINE + 1);
        revenueCounter.setRevenue(REVENUE_THRESHOLD - 1);

        vm.expectEmit(true, false, false, true);
        emit WindDownTriggered(randomUser, block.timestamp);
        vm.prank(randomUser);
        windDown.triggerWindDown();

        assertTrue(windDown.triggered());
    }

    function test_permissionlessTrigger_failsBeforeDeadline() public {
        revenueCounter.setRevenue(0);
        // Still before deadline
        vm.warp(WIND_DOWN_DEADLINE - 1);

        vm.prank(randomUser);
        vm.expectRevert("ArmadaWindDown: deadline not passed");
        windDown.triggerWindDown();
    }

    function test_permissionlessTrigger_failsAboveThreshold() public {
        vm.warp(WIND_DOWN_DEADLINE + 1);
        revenueCounter.setRevenue(REVENUE_THRESHOLD); // exactly at threshold

        vm.prank(randomUser);
        vm.expectRevert("ArmadaWindDown: revenue meets threshold");
        windDown.triggerWindDown();
    }

    function test_permissionlessTrigger_failsAtExactDeadline() public {
        revenueCounter.setRevenue(0);
        vm.warp(WIND_DOWN_DEADLINE); // at deadline, not past

        vm.prank(randomUser);
        vm.expectRevert("ArmadaWindDown: deadline not passed");
        windDown.triggerWindDown();
    }

    // ======== Governance Trigger ========

    function test_governanceTrigger_succeeds() public {
        // Timelock can trigger at any time
        vm.prank(address(timelock));
        vm.expectEmit(true, false, false, true);
        emit WindDownTriggered(address(timelock), block.timestamp);
        windDown.governanceTriggerWindDown();

        assertTrue(windDown.triggered());
    }

    function test_governanceTrigger_failsForNonTimelock() public {
        vm.prank(randomUser);
        vm.expectRevert("ArmadaWindDown: not timelock");
        windDown.governanceTriggerWindDown();
    }

    function test_doubleTriggerReverts() public {
        vm.prank(address(timelock));
        windDown.governanceTriggerWindDown();

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaWindDown: already triggered");
        windDown.governanceTriggerWindDown();
    }

    // ======== Wind-Down Hook Effects ========

    function test_executeWindDown_setsTokenTransferable() public {
        assertFalse(armToken.transferable());

        vm.prank(address(timelock));
        windDown.governanceTriggerWindDown();

        assertTrue(armToken.transferable());
    }

    function test_executeWindDown_disablesGovernance() public {
        assertFalse(governor.windDownActive());

        vm.prank(address(timelock));
        windDown.governanceTriggerWindDown();

        assertTrue(governor.windDownActive());
    }

    function test_executeWindDown_activatesPauseWindDown() public {
        assertFalse(pauseController.windDownActive());

        vm.prank(address(timelock));
        windDown.governanceTriggerWindDown();

        assertTrue(pauseController.windDownActive());
    }

    // ======== Sweep Token ========

    function test_sweepToken_movesToRedemption() public {
        _triggerWindDown();

        uint256 balance = usdc.balanceOf(address(treasury));
        vm.expectEmit(true, true, false, true);
        emit TokenSwept(address(usdc), address(redemption), balance);
        windDown.sweepToken(address(usdc));

        assertEq(usdc.balanceOf(address(redemption)), balance);
        assertEq(usdc.balanceOf(address(treasury)), 0);
    }

    function test_sweepToken_revertsForARM() public {
        _triggerWindDown();

        vm.expectRevert("ArmadaWindDown: cannot sweep ARM");
        windDown.sweepToken(address(armToken));
    }

    function test_sweepToken_revertsBeforeTrigger() public {
        vm.expectRevert("ArmadaWindDown: not triggered");
        windDown.sweepToken(address(usdc));
    }

    function test_sweepToken_revertsNoBalance() public {
        _triggerWindDown();

        MockUSDCWindDown otherToken = new MockUSDCWindDown();
        vm.expectRevert("ArmadaWindDown: no balance");
        windDown.sweepToken(address(otherToken));
    }

    function test_sweepToken_permissionless() public {
        _triggerWindDown();

        // Anyone can call sweep
        vm.prank(randomUser);
        windDown.sweepToken(address(usdc));

        assertEq(usdc.balanceOf(address(redemption)), 500_000e6);
    }

    // ======== Sweep ETH ========

    function test_sweepETH_movesToRedemption() public {
        _triggerWindDown();
        _fundTreasuryETH(10 ether);

        vm.expectEmit(true, false, false, true);
        emit ETHSwept(address(redemption), 10 ether);
        windDown.sweepETH();

        assertEq(address(redemption).balance, 10 ether);
        assertEq(address(treasury).balance, 0);
    }

    function test_sweepETH_revertsBeforeTrigger() public {
        _fundTreasuryETH(10 ether);

        vm.expectRevert("ArmadaWindDown: not triggered");
        windDown.sweepETH();
    }

    function test_sweepETH_revertsNoBalance() public {
        _triggerWindDown();

        vm.expectRevert("ArmadaWindDown: no balance");
        windDown.sweepETH();
    }

    // ======== Parameter Setters ========

    function test_setRevenueThreshold_timelockOnly() public {
        vm.prank(address(timelock));
        vm.expectEmit(false, false, false, true);
        emit RevenueThresholdUpdated(REVENUE_THRESHOLD, 50_000e18);
        windDown.setRevenueThreshold(50_000e18);

        assertEq(windDown.revenueThreshold(), 50_000e18);
    }

    function test_setRevenueThreshold_nonTimelockReverts() public {
        vm.prank(randomUser);
        vm.expectRevert("ArmadaWindDown: not timelock");
        windDown.setRevenueThreshold(50_000e18);
    }

    function test_setWindDownDeadline_timelockOnly() public {
        uint256 newDeadline = WIND_DOWN_DEADLINE + 365 days;
        vm.prank(address(timelock));
        vm.expectEmit(false, false, false, true);
        emit WindDownDeadlineUpdated(WIND_DOWN_DEADLINE, newDeadline);
        windDown.setWindDownDeadline(newDeadline);

        assertEq(windDown.windDownDeadline(), newDeadline);
    }

    function test_parameterSetters_revertAfterTrigger() public {
        _triggerWindDown();

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaWindDown: already triggered");
        windDown.setRevenueThreshold(50_000e18);

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaWindDown: already triggered");
        windDown.setWindDownDeadline(WIND_DOWN_DEADLINE + 365 days);
    }

    // ======== Constructor Validation ========

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert("ArmadaWindDown: zero armToken");
        new ArmadaWindDown(
            address(0), address(treasury), address(governor), address(redemption),
            address(pauseController), address(revenueCounter), address(timelock),
            REVENUE_THRESHOLD, WIND_DOWN_DEADLINE
        );
    }

    function test_constructorRejectsDeadlineInPast() public {
        vm.expectRevert("ArmadaWindDown: deadline in past");
        new ArmadaWindDown(
            address(armToken), address(treasury), address(governor), address(redemption),
            address(pauseController), address(revenueCounter), address(timelock),
            REVENUE_THRESHOLD, block.timestamp - 1
        );
    }

    function test_constructorRejectsZeroThreshold() public {
        vm.expectRevert("ArmadaWindDown: zero threshold");
        new ArmadaWindDown(
            address(armToken), address(treasury), address(governor), address(redemption),
            address(pauseController), address(revenueCounter), address(timelock),
            0, WIND_DOWN_DEADLINE
        );
    }

    // ======== Parameter Bounds ========

    function test_setRevenueThreshold_rejectsZero() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaWindDown: zero threshold");
        windDown.setRevenueThreshold(0);
    }

    function test_setWindDownDeadline_rejectsPastTimestamp() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaWindDown: deadline in past");
        windDown.setWindDownDeadline(block.timestamp - 1);
    }

    function test_setWindDownDeadline_rejectsCurrentTimestamp() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaWindDown: deadline in past");
        windDown.setWindDownDeadline(block.timestamp);
    }

    // ======== Helpers ========

    function _triggerWindDown() internal {
        vm.prank(address(timelock));
        windDown.governanceTriggerWindDown();
    }

    function _fundTreasuryETH(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool success,) = address(treasury).call{value: amount}("");
        require(success, "ETH transfer failed");
    }
}

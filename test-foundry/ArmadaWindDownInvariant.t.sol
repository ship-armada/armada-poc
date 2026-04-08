// SPDX-License-Identifier: MIT
// ABOUTME: Foundry invariant tests for ArmadaWindDown — trigger irreversibility, condition enforcement.
// ABOUTME: Uses a stateful handler to fuzz trigger attempts across varying revenue and time states.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaWindDown.sol";

/// @dev Mock contracts for WindDown dependencies
contract MockTokenWD {
    bool public transferable;
    function setTransferable(bool _t) external { transferable = _t; }
}

contract MockGovernorWD {
    bool public windDownActive;
    function setWindDownActive() external { windDownActive = true; }
}

contract MockPauseWD {
    bool public windDownActive;
    function setWindDownActive() external { windDownActive = true; }
}

contract MockRevenueWD {
    uint256 public recognizedRevenueUsd;
    function setRevenue(uint256 r) external { recognizedRevenueUsd = r; }
}

contract MockTreasuryWD {
    function transferTo(address, address, uint256) external {}
    function transferETHTo(address payable, uint256) external {}
}

/// @dev Handler contract for stateful fuzzing of ArmadaWindDown
contract WindDownHandler is Test {
    ArmadaWindDown public windDown;
    MockRevenueWD public revenueCounter;
    address public timelock;

    uint256 public ghost_triggerCount;
    uint256 public ghost_revertCount;

    constructor(ArmadaWindDown _wd, MockRevenueWD _rc, address _timelock) {
        windDown = _wd;
        revenueCounter = _rc;
        timelock = _timelock;
    }

    /// @dev Fuzzed: set revenue to an arbitrary amount
    function setRevenue(uint256 revenue) external {
        revenue = bound(revenue, 0, 2_000_000e18);
        revenueCounter.setRevenue(revenue);
    }

    /// @dev Fuzzed: advance time by a random amount
    function advanceTime(uint256 delta) external {
        delta = bound(delta, 0, 365 days);
        vm.warp(block.timestamp + delta);
    }

    /// @dev Fuzzed: attempt permissionless trigger
    function tryTrigger() external {
        try windDown.triggerWindDown() {
            ghost_triggerCount++;
        } catch {
            ghost_revertCount++;
        }
    }

    /// @dev Fuzzed: attempt governance trigger
    function tryGovernanceTrigger() external {
        vm.prank(timelock);
        try windDown.governanceTriggerWindDown() {
            ghost_triggerCount++;
        } catch {
            ghost_revertCount++;
        }
    }
}

contract ArmadaWindDownInvariantTest is Test {
    ArmadaWindDown public windDown;
    MockTokenWD public token;
    MockGovernorWD public governor;
    MockPauseWD public pauseCtrl;
    MockRevenueWD public revenueCounter;
    MockTreasuryWD public treasury;
    WindDownHandler public handler;

    address public timelock = address(0x7140);
    address public redemption = address(0x4D);

    uint256 constant THRESHOLD = 500_000e18;
    uint256 constant DEADLINE = 100 days;

    function setUp() public {
        token = new MockTokenWD();
        governor = new MockGovernorWD();
        pauseCtrl = new MockPauseWD();
        revenueCounter = new MockRevenueWD();
        treasury = new MockTreasuryWD();

        windDown = new ArmadaWindDown(
            address(token),
            address(treasury),
            address(governor),
            redemption,
            address(pauseCtrl),
            address(revenueCounter),
            timelock,
            THRESHOLD,
            block.timestamp + DEADLINE
        );

        handler = new WindDownHandler(windDown, revenueCounter, timelock);
        targetContract(address(handler));
    }

    /// @notice INV-WD1: Once triggered, the triggered flag is permanently true.
    ///         WHY: Wind-down is irreversible by design — no path should clear the flag.
    function invariant_triggeredIsPermanent() public {
        if (handler.ghost_triggerCount() > 0) {
            assertTrue(windDown.triggered(), "INV-WD1: triggered must be permanent");
        }
    }

    /// @notice INV-WD2: At most one successful trigger can occur.
    ///         WHY: Both trigger functions check !triggered, so only one should succeed.
    function invariant_atMostOneTrigger() public {
        assertLe(handler.ghost_triggerCount(), 1, "INV-WD2: at most one trigger");
    }

    /// @notice INV-WD3: If triggered, all downstream effects must be active.
    ///         WHY: _executeWindDown sets transferable, windDownActive on governor and pause.
    function invariant_triggerEffects() public {
        if (windDown.triggered()) {
            assertTrue(token.transferable(), "INV-WD3: token must be transferable");
            assertTrue(governor.windDownActive(), "INV-WD3: governor must be wind-down active");
            assertTrue(pauseCtrl.windDownActive(), "INV-WD3: pause must be wind-down active");
        }
    }
}

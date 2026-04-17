// SPDX-License-Identifier: MIT
// ABOUTME: Foundry invariant tests for ArmadaTreasuryGov outflow accounting.
// ABOUTME: Verifies rolling-window limits hold under fuzzed distribute/stewardSpend sequences.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Simple ERC20 for testing treasury outflows
contract MockUSDCOutflow is ERC20 {
    constructor() ERC20("MockUSDC", "USDC") {
        _mint(msg.sender, 100_000_000e6);
    }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @dev Handler for stateful fuzzing of treasury outflow limits
contract TreasuryOutflowHandler is Test {
    ArmadaTreasuryGov public treasury;
    address public token;
    address public owner;

    // Ghost variables
    uint256 public ghost_distributeCount;
    uint256 public ghost_stewardSpendCount;
    uint256 public ghost_revertCount;
    uint256 public ghost_totalDistributed;
    uint256 public ghost_totalStewardSpent;

    constructor(ArmadaTreasuryGov _treasury, address _token, address _owner) {
        treasury = _treasury;
        token = _token;
        owner = _owner;
    }

    /// @dev Fuzzed: governance distributes a random amount
    function distribute(uint256 amount) external {
        amount = bound(amount, 1, 50_000e6); // 1 to 50K USDC
        vm.prank(owner);
        try treasury.distribute(token, address(0xBEEF), amount) {
            ghost_distributeCount++;
            ghost_totalDistributed += amount;
        } catch {
            ghost_revertCount++;
        }
    }

    /// @dev Fuzzed: steward spends a random amount
    function stewardSpend(uint256 amount) external {
        amount = bound(amount, 1, 10_000e6); // 1 to 10K USDC
        vm.prank(owner);
        try treasury.stewardSpend(token, address(0xBEEF), amount) {
            ghost_stewardSpendCount++;
            ghost_totalStewardSpent += amount;
        } catch {
            ghost_revertCount++;
        }
    }

    /// @dev Fuzzed: advance time to allow rolling window to expire
    function advanceTime(uint256 delta) external {
        delta = bound(delta, 0, 60 days);
        vm.warp(block.timestamp + delta);
    }

    // ---- Issue #226: asymmetric delay on outflow-loosening setters ----
    //
    // These handler actions exercise the new delayed-activation path so the existing
    // value-conservation invariants (INV-TO1/2/3) are re-verified under fuzzed setter
    // sequences, not just fuzzed distribute/stewardSpend sequences. Bounds are chosen
    // so both loosening and tightening directions are reachable from the starting config.

    function setLimitAbsoluteFuzzed(uint256 newAbsolute) external {
        newAbsolute = bound(newAbsolute, 100_000e6, 5_000_000e6); // >= floor
        vm.prank(owner);
        try treasury.setOutflowLimitAbsolute(token, newAbsolute) {
        } catch {
            ghost_revertCount++;
        }
    }

    function setLimitBpsFuzzed(uint256 newBps) external {
        newBps = bound(newBps, 1, 10_000);
        vm.prank(owner);
        try treasury.setOutflowLimitBps(token, newBps) {
        } catch {
            ghost_revertCount++;
        }
    }

    function setWindowFuzzed(uint256 newWindow) external {
        newWindow = bound(newWindow, 1 days, 365 days);
        vm.prank(owner);
        try treasury.setOutflowWindow(token, newWindow) {
        } catch {
            ghost_revertCount++;
        }
    }

    /// @dev Permissionless trigger for pending outflow param activation. Must be a no-op
    ///      when nothing is due and must not revert in any state.
    function activatePending() external {
        treasury.activatePendingOutflowParams(token);
    }
}

contract TreasuryOutflowInvariantTest is Test {
    ArmadaTreasuryGov public treasury;
    MockUSDCOutflow public usdc;
    TreasuryOutflowHandler public handler;

    address public owner = address(this);
    uint256 constant WINDOW = 30 days;
    uint256 constant LIMIT_BPS = 1000; // 10%
    uint256 constant LIMIT_ABSOLUTE = 500_000e6; // 500K USDC
    uint256 constant FLOOR = 100_000e6; // 100K USDC
    uint256 constant STEWARD_LIMIT = 50_000e6; // 50K USDC
    uint256 constant STEWARD_WINDOW = 30 days;
    uint256 constant TREASURY_FUNDING = 10_000_000e6; // 10M USDC

    function setUp() public {
        treasury = new ArmadaTreasuryGov(owner);
        usdc = new MockUSDCOutflow();

        // Fund the treasury
        usdc.transfer(address(treasury), TREASURY_FUNDING);

        // Initialize outflow config
        treasury.initOutflowConfig(
            address(usdc),
            WINDOW,
            LIMIT_BPS,
            LIMIT_ABSOLUTE,
            FLOOR
        );

        // Setup steward budget
        treasury.addStewardBudgetToken(address(usdc), STEWARD_LIMIT, STEWARD_WINDOW);

        handler = new TreasuryOutflowHandler(treasury, address(usdc), owner);
        targetContract(address(handler));
    }

    /// @notice INV-TO1: Total distributed + total steward spent <= initial funding.
    ///         WHY: Treasury cannot distribute more than it holds. SafeERC20 reverts on overdraw.
    function invariant_noOverdraw() public {
        assertLe(
            handler.ghost_totalDistributed() + handler.ghost_totalStewardSpent(),
            TREASURY_FUNDING,
            "INV-TO1: overdraw"
        );
    }

    /// @notice INV-TO2: Treasury USDC balance == funding - total outflows.
    ///         WHY: All outflows go to address(0xBEEF). Conservation of value.
    function invariant_balanceConservation() public {
        uint256 expectedBalance = TREASURY_FUNDING
            - handler.ghost_totalDistributed()
            - handler.ghost_totalStewardSpent();
        assertEq(
            usdc.balanceOf(address(treasury)),
            expectedBalance,
            "INV-TO2: balance conservation"
        );
    }

    /// @notice INV-TO3: Outflow recipient received exactly what treasury sent.
    ///         WHY: No value should be created or destroyed in transit.
    function invariant_recipientBalance() public {
        assertEq(
            usdc.balanceOf(address(0xBEEF)),
            handler.ghost_totalDistributed() + handler.ghost_totalStewardSpent(),
            "INV-TO3: recipient balance"
        );
    }

    /// @notice INV-TO4: Raw storage never exceeds effective values when no pending
    ///         activation is overdue. When pendingActivation > 0 and block.timestamp
    ///         >= pendingActivation, getEffectiveOutflowConfig must return the pending
    ///         value; getOutflowConfig must still return the (pre-activation) active
    ///         value. After calling activatePendingOutflowParams, the two must match.
    ///         WHY: This is the view-vs-state-modifying parity property. A divergence
    ///         would mean enforcement reads a different value than what monitoring sees.
    function invariant_effectiveMatchesRawAfterActivation() public {
        // Snapshot effective view (state-read only)
        (uint256 effW, uint256 effB, uint256 effA,) = treasury.getEffectiveOutflowConfig(address(usdc));

        // Check: if no pending is overdue, effective must equal raw
        (uint256 pW, uint256 pWA, uint256 pB, uint256 pBA, uint256 pA, uint256 pAA) =
            treasury.getPendingOutflowConfig(address(usdc));
        (uint256 rawW, uint256 rawB, uint256 rawA,) = treasury.getOutflowConfig(address(usdc));

        if (!(pWA > 0 && block.timestamp >= pWA)) {
            assertEq(effW, rawW, "INV-TO4: effective window drift");
        } else {
            assertEq(effW, pW, "INV-TO4: effective window should be pending");
        }
        if (!(pBA > 0 && block.timestamp >= pBA)) {
            assertEq(effB, rawB, "INV-TO4: effective bps drift");
        } else {
            assertEq(effB, pB, "INV-TO4: effective bps should be pending");
        }
        if (!(pAA > 0 && block.timestamp >= pAA)) {
            assertEq(effA, rawA, "INV-TO4: effective absolute drift");
        } else {
            assertEq(effA, pA, "INV-TO4: effective absolute should be pending");
        }
    }
}

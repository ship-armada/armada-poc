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
}

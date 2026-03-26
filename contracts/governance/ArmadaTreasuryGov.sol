// SPDX-License-Identifier: MIT
// ABOUTME: Governance-controlled treasury with steward budget and aggregate outflow rate limits.
// ABOUTME: Outflow limits enforce a rolling-window cap per token to defend against governance capture.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title ArmadaTreasuryGov — Governance-controlled treasury
/// @notice Owned by TimelockController (immutable). Supports direct distributions,
///         steward operational budget, and aggregate outflow rate limits per token
///         over a rolling window.
contract ArmadaTreasuryGov is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Types ============

    /// @notice Per-token outflow rate limit configuration.
    /// The effective limit is: max(percentageOfBalance, limitAbsolute),
    /// then max(result, floorAbsolute). The floor is immutable once set.
    struct OutflowConfig {
        uint256 windowDuration;   // rolling window in seconds (e.g. 30 days)
        uint256 limitBps;         // percentage of current treasury balance (1000 = 10%)
        uint256 limitAbsolute;    // absolute cap in token units
        uint256 floorAbsolute;    // immutable minimum — governance can never reduce below this
        bool initialized;         // whether config has been set for this token
    }

    /// @notice Record of a single outflow event, used for rolling window accounting.
    struct OutflowRecord {
        uint256 amount;
        uint256 timestamp;
    }

    // ============ State ============

    address public immutable owner; // TimelockController address (set once at deployment, cannot be changed)

    // Per-token steward budget table (governance-managed via Extended proposals).
    // Each authorized token has an absolute spending limit per rolling window.
    // Unused budget does not carry over between windows.
    struct StewardBudget {
        uint256 limit;         // max spend per window in token units
        uint256 window;        // window duration in seconds
        bool authorized;       // whether steward can spend this token
    }

    mapping(address => StewardBudget) public stewardBudgets;
    mapping(address => uint256) public stewardBudgetSpent;
    mapping(address => uint256) public stewardBudgetWindowStart;

    // Aggregate outflow rate limits (per token)
    //
    // Both governance distributions and steward spending count against the same
    // rolling-window limit. This is the primary defense against governance capture:
    // even a compromised governance can only drain the treasury at a limited rate,
    // giving stakeholders time to respond.
    mapping(address => OutflowConfig) internal _outflowConfigs;
    mapping(address => OutflowRecord[]) internal _outflowHistory;

    // Wind-down sweep authority
    /// @notice Wind-down contract address (only caller for transferTo/transferETHTo)
    address public windDownContract;
    /// @notice Whether the wind-down contract has been set (one-time setter lock)
    bool public windDownContractSet;

    // ============ Events ============

    event DirectDistribution(address indexed token, address indexed recipient, uint256 amount);
    event StewardSpent(address indexed token, address indexed recipient, uint256 amount, uint256 budgetRemaining);
    event StewardBudgetTokenAdded(address indexed token, uint256 limit, uint256 window);
    event StewardBudgetTokenUpdated(address indexed token, uint256 limit, uint256 window);
    event StewardBudgetTokenRemoved(address indexed token);
    event OutflowConfigInitialized(address indexed token, uint256 windowDuration, uint256 limitBps, uint256 limitAbsolute, uint256 floorAbsolute);
    event OutflowWindowUpdated(address indexed token, uint256 newWindow);
    event OutflowLimitBpsUpdated(address indexed token, uint256 newBps);
    event OutflowLimitAbsoluteUpdated(address indexed token, uint256 newAbsolute);
    event WindDownContractSet(address indexed windDownContract);
    event WindDownTransfer(address indexed token, address indexed recipient, uint256 amount);
    event WindDownETHTransfer(address indexed recipient, uint256 amount);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaTreasuryGov: not owner");
        _;
    }

    // ============ Constructor ============

    constructor(address _owner) {
        require(_owner != address(0), "ArmadaTreasuryGov: zero owner");
        owner = _owner; // Should be the timelock address
    }

    // ============ Governance Functions (owner = timelock) ============

    /// @notice Direct distribution: send tokens to recipient immediately
    function distribute(address token, address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        _checkAndRecordOutflow(token, amount);
        IERC20(token).safeTransfer(recipient, amount);
        emit DirectDistribution(token, recipient, amount);
    }

    // ============ Steward Spending (executed by timelock via governor) ============

    /// @notice Execute a steward spend from the per-token budget.
    /// @dev Called by the timelock after a steward proposal passes through governance.
    /// Budget enforcement uses an absolute per-token limit over a rolling window,
    /// configured via addStewardBudgetToken/updateStewardBudgetToken.
    function stewardSpend(address token, address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");

        StewardBudget storage budget = stewardBudgets[token];
        require(budget.authorized, "ArmadaTreasuryGov: token not authorized for steward");

        // Reset window if expired
        if (block.timestamp >= stewardBudgetWindowStart[token] + budget.window) {
            stewardBudgetSpent[token] = 0;
            stewardBudgetWindowStart[token] = block.timestamp;
        }

        require(
            stewardBudgetSpent[token] + amount <= budget.limit,
            "ArmadaTreasuryGov: exceeds steward budget"
        );

        stewardBudgetSpent[token] += amount;
        _checkAndRecordOutflow(token, amount);
        IERC20(token).safeTransfer(recipient, amount);

        uint256 remaining = budget.limit - stewardBudgetSpent[token];
        emit StewardSpent(token, recipient, amount, remaining);
    }

    // ============ Steward Budget Management (owner = timelock) ============

    /// @notice Add a new token to the steward budget table.
    /// @param token Token address to authorize for steward spending
    /// @param limit Maximum spend per window in token units
    /// @param window Window duration in seconds (minimum 1 day)
    function addStewardBudgetToken(address token, uint256 limit, uint256 window) external onlyOwner {
        require(!stewardBudgets[token].authorized, "ArmadaTreasuryGov: token already authorized");
        require(limit > 0, "ArmadaTreasuryGov: zero limit");
        require(window >= 1 days, "ArmadaTreasuryGov: window too short");

        stewardBudgets[token] = StewardBudget({
            limit: limit,
            window: window,
            authorized: true
        });

        emit StewardBudgetTokenAdded(token, limit, window);
    }

    /// @notice Update an existing steward budget token's parameters.
    /// @param token Token address (must already be authorized)
    /// @param limit New maximum spend per window in token units
    /// @param window New window duration in seconds (minimum 1 day)
    function updateStewardBudgetToken(address token, uint256 limit, uint256 window) external onlyOwner {
        require(stewardBudgets[token].authorized, "ArmadaTreasuryGov: token not authorized");
        require(limit > 0, "ArmadaTreasuryGov: zero limit");
        require(window >= 1 days, "ArmadaTreasuryGov: window too short");

        stewardBudgets[token].limit = limit;
        stewardBudgets[token].window = window;

        emit StewardBudgetTokenUpdated(token, limit, window);
    }

    /// @notice Remove a token from the steward budget table, disabling steward spending.
    /// @param token Token address to deauthorize
    function removeStewardBudgetToken(address token) external onlyOwner {
        require(stewardBudgets[token].authorized, "ArmadaTreasuryGov: token not authorized");

        delete stewardBudgets[token];
        stewardBudgetSpent[token] = 0;
        stewardBudgetWindowStart[token] = 0;

        emit StewardBudgetTokenRemoved(token);
    }

    // ============ Outflow Rate Limit Management (owner = timelock) ============

    /// @notice Initialize outflow config for a token. Callable once per token by owner.
    /// @param token Token address
    /// @param windowDuration Rolling window in seconds (minimum 1 day)
    /// @param limitBps Percentage of treasury balance (e.g. 1000 = 10%)
    /// @param limitAbsolute Absolute cap in token units
    /// @param floorAbsolute Immutable minimum — governance can never reduce absolute below this
    function initOutflowConfig(
        address token,
        uint256 windowDuration,
        uint256 limitBps,
        uint256 limitAbsolute,
        uint256 floorAbsolute
    ) external onlyOwner {
        require(!_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow already initialized");
        require(windowDuration >= 1 days, "ArmadaTreasuryGov: window too short");
        require(limitBps <= 10000, "ArmadaTreasuryGov: bps out of range");
        require(limitAbsolute >= floorAbsolute, "ArmadaTreasuryGov: absolute below floor");

        _outflowConfigs[token] = OutflowConfig({
            windowDuration: windowDuration,
            limitBps: limitBps,
            limitAbsolute: limitAbsolute,
            floorAbsolute: floorAbsolute,
            initialized: true
        });

        emit OutflowConfigInitialized(token, windowDuration, limitBps, limitAbsolute, floorAbsolute);
    }

    /// @notice Update the rolling window duration for a token's outflow limit.
    function setOutflowWindow(address token, uint256 newWindow) external onlyOwner {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow not initialized");
        require(newWindow >= 1 days, "ArmadaTreasuryGov: window too short");
        _outflowConfigs[token].windowDuration = newWindow;
        emit OutflowWindowUpdated(token, newWindow);
    }

    /// @notice Update the percentage-based outflow limit for a token.
    function setOutflowLimitBps(address token, uint256 newBps) external onlyOwner {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow not initialized");
        require(newBps <= 10000, "ArmadaTreasuryGov: bps out of range");
        _outflowConfigs[token].limitBps = newBps;
        emit OutflowLimitBpsUpdated(token, newBps);
    }

    /// @notice Update the absolute outflow limit for a token. Cannot be set below floor.
    function setOutflowLimitAbsolute(address token, uint256 newAbsolute) external onlyOwner {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow not initialized");
        require(newAbsolute >= _outflowConfigs[token].floorAbsolute, "ArmadaTreasuryGov: absolute below floor");
        _outflowConfigs[token].limitAbsolute = newAbsolute;
        emit OutflowLimitAbsoluteUpdated(token, newAbsolute);
    }

    // ============ Internal: Outflow Enforcement ============

    /// @dev Check that a proposed outflow does not exceed the rolling-window limit,
    ///      and record the outflow if it passes. Skips if no config is initialized.
    function _checkAndRecordOutflow(address token, uint256 amount) internal {
        OutflowConfig storage config = _outflowConfigs[token];
        if (!config.initialized) return; // no limit configured — allow

        // Calculate effective limit: max(pct of current balance, absolute), then max(result, floor)
        uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
        uint256 pctLimit = (treasuryBalance * config.limitBps) / 10000;
        uint256 effectiveLimit = pctLimit > config.limitAbsolute ? pctLimit : config.limitAbsolute;
        if (effectiveLimit < config.floorAbsolute) {
            effectiveLimit = config.floorAbsolute;
        }

        // Sum recent outflows within the rolling window
        uint256 recentOutflow = _sumRecentOutflows(token, config.windowDuration);

        require(
            recentOutflow + amount <= effectiveLimit,
            "ArmadaTreasuryGov: outflow limit exceeded"
        );

        // Record this outflow
        _outflowHistory[token].push(OutflowRecord({
            amount: amount,
            timestamp: block.timestamp
        }));
    }

    /// @dev Sum outflow amounts within the rolling window, iterating backwards from most recent.
    function _sumRecentOutflows(address token, uint256 windowDuration) internal view returns (uint256 total) {
        OutflowRecord[] storage records = _outflowHistory[token];
        uint256 len = records.length;
        if (len == 0) return 0;

        uint256 cutoff = block.timestamp > windowDuration ? block.timestamp - windowDuration : 0;

        // Iterate backwards — most recent records are at the end
        for (uint256 i = len; i > 0; i--) {
            OutflowRecord storage r = records[i - 1];
            if (r.timestamp < cutoff) break; // older entries are further back, stop early
            total += r.amount;
        }
    }

    // ============ Wind-Down Sweep Authority ============

    /// @notice Set the wind-down contract address. One-time setter, timelock-only.
    function setWindDownContract(address _windDownContract) external onlyOwner {
        require(!windDownContractSet, "ArmadaTreasuryGov: wind-down already set");
        require(_windDownContract != address(0), "ArmadaTreasuryGov: zero address");
        windDownContractSet = true;
        windDownContract = _windDownContract;
        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Transfer ERC20 tokens from treasury to recipient. Wind-down contract only.
    ///         Bypasses outflow limits — wind-down is a special authority.
    function transferTo(address token, address recipient, uint256 amount) external {
        require(msg.sender == windDownContract, "ArmadaTreasuryGov: not wind-down");
        require(recipient != address(0), "ArmadaTreasuryGov: zero recipient");
        IERC20(token).safeTransfer(recipient, amount);
        emit WindDownTransfer(token, recipient, amount);
    }

    /// @notice Transfer ETH from treasury to recipient. Wind-down contract only.
    ///         Bypasses outflow limits — wind-down is a special authority.
    function transferETHTo(address payable recipient, uint256 amount) external {
        require(msg.sender == windDownContract, "ArmadaTreasuryGov: not wind-down");
        require(recipient != address(0), "ArmadaTreasuryGov: zero recipient");
        (bool success,) = recipient.call{value: amount}("");
        require(success, "ArmadaTreasuryGov: ETH transfer failed");
        emit WindDownETHTransfer(recipient, amount);
    }

    /// @notice Accept ETH deposits
    receive() external payable {}

    // ============ View Functions ============

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice View the steward's current budget status for a token
    function getStewardBudget(address token) external view returns (uint256 budget, uint256 spent, uint256 remaining) {
        StewardBudget storage b = stewardBudgets[token];
        if (!b.authorized) return (0, 0, 0);

        budget = b.limit;
        if (block.timestamp >= stewardBudgetWindowStart[token] + b.window) {
            // Window expired — full budget available
            spent = 0;
        } else {
            spent = stewardBudgetSpent[token];
        }
        remaining = budget > spent ? budget - spent : 0;
    }

    /// @notice Get the outflow configuration for a token.
    function getOutflowConfig(address token) external view returns (
        uint256 windowDuration,
        uint256 limitBps,
        uint256 limitAbsolute,
        uint256 floorAbsolute
    ) {
        OutflowConfig storage config = _outflowConfigs[token];
        return (config.windowDuration, config.limitBps, config.limitAbsolute, config.floorAbsolute);
    }

    /// @notice Get the current outflow status for a token: effective limit, recent outflow, and available.
    function getOutflowStatus(address token) external view returns (
        uint256 effectiveLimit,
        uint256 recentOutflow,
        uint256 available
    ) {
        OutflowConfig storage config = _outflowConfigs[token];
        if (!config.initialized) return (0, 0, 0);

        uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
        uint256 pctLimit = (treasuryBalance * config.limitBps) / 10000;
        effectiveLimit = pctLimit > config.limitAbsolute ? pctLimit : config.limitAbsolute;
        if (effectiveLimit < config.floorAbsolute) {
            effectiveLimit = config.floorAbsolute;
        }

        recentOutflow = _sumRecentOutflows(token, config.windowDuration);
        available = effectiveLimit > recentOutflow ? effectiveLimit - recentOutflow : 0;
    }
}

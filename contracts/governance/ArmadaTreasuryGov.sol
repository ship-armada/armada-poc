// SPDX-License-Identifier: MIT
// ABOUTME: Governance-controlled treasury with claims, steward budget, and aggregate outflow rate limits.
// ABOUTME: Outflow limits enforce a rolling-window cap per token to defend against governance capture.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./EmergencyPausable.sol";

/// @title ArmadaTreasuryGov — Governance-controlled treasury with claims mechanism
/// @notice Owned by TimelockController (immutable). Supports direct distributions,
///         claims (deferred exercise), steward operational budget, and aggregate
///         outflow rate limits per token over a rolling window.
contract ArmadaTreasuryGov is ReentrancyGuard, EmergencyPausable {
    using SafeERC20 for IERC20;

    // ============ Types ============

    struct Claim {
        address token;
        address beneficiary;
        uint256 amount;
        uint256 exercised;
        uint256 createdAt;
    }

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
    address public steward; // Treasury steward (limited powers)

    // Claims system
    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;
    mapping(address => uint256[]) private _beneficiaryClaims;

    // Steward budget tracking (per token)
    //
    // The steward can spend up to 1% of the treasury balance per 30-day period.
    // The budget basis (treasury balance used for the 1% calculation) is snapshotted
    // once at the start of each period and held constant for the full 30 days.
    // This prevents mid-period balance changes from shifting the budget.
    //
    // The 30-day period starts on the steward's first spend after the previous period
    // expires (not on a fixed calendar schedule). Changing the steward does not reset
    // the budget window or the amount already spent.
    uint256 public constant STEWARD_BUDGET_BPS = 100; // 1%
    uint256 public constant BUDGET_PERIOD = 30 days;
    mapping(address => uint256) public budgetSpentThisPeriod; // cumulative spend in current period
    mapping(address => uint256) public lastBudgetReset; // timestamp when current period started
    mapping(address => uint256) public budgetBasis; // treasury balance snapshotted at period start

    // Aggregate outflow rate limits (per token)
    //
    // Both governance distributions and steward spending count against the same
    // rolling-window limit. This is the primary defense against governance capture:
    // even a compromised governance can only drain the treasury at a limited rate,
    // giving stakeholders time to respond.
    mapping(address => OutflowConfig) internal _outflowConfigs;
    mapping(address => OutflowRecord[]) internal _outflowHistory;

    // ============ Events ============

    event DirectDistribution(address indexed token, address indexed recipient, uint256 amount);
    event ClaimCreated(uint256 indexed claimId, address indexed beneficiary, address token, uint256 amount);
    event ClaimExercised(uint256 indexed claimId, address indexed beneficiary, uint256 amount);
    event StewardUpdated(address indexed oldSteward, address indexed newSteward);
    event StewardSpent(address indexed token, address indexed recipient, uint256 amount, uint256 budgetRemaining);
    event OutflowConfigInitialized(address indexed token, uint256 windowDuration, uint256 limitBps, uint256 limitAbsolute, uint256 floorAbsolute);
    event OutflowWindowUpdated(address indexed token, uint256 newWindow);
    event OutflowLimitBpsUpdated(address indexed token, uint256 newBps);
    event OutflowLimitAbsoluteUpdated(address indexed token, uint256 newAbsolute);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(msg.sender == owner, "ArmadaTreasuryGov: not owner");
        _;
    }

    modifier onlySteward() {
        require(msg.sender == steward, "ArmadaTreasuryGov: not steward");
        _;
    }

    // ============ Constructor ============

    constructor(
        address _owner,
        address _guardian,
        uint256 _maxPauseDuration
    ) EmergencyPausable(_guardian, _maxPauseDuration, _owner) {
        require(_owner != address(0), "ArmadaTreasuryGov: zero owner");
        owner = _owner; // Should be the timelock address
    }

    // ============ Governance Functions (owner = timelock) ============

    /// @notice Direct distribution: send tokens to recipient immediately
    function distribute(address token, address recipient, uint256 amount) external onlyOwner whenNotPaused {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        _checkAndRecordOutflow(token, amount);
        IERC20(token).safeTransfer(recipient, amount);
        emit DirectDistribution(token, recipient, amount);
    }

    /// @notice Create a claim: right to receive tokens, exercisable by beneficiary
    /// @param token Token address
    /// @param beneficiary Address that can exercise the claim
    /// @param amount Total claimable amount
    function createClaim(
        address token,
        address beneficiary,
        uint256 amount
    ) external onlyOwner returns (uint256) {
        require(beneficiary != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");

        uint256 claimId = ++claimCount;
        claims[claimId] = Claim({
            token: token,
            beneficiary: beneficiary,
            amount: amount,
            exercised: 0,
            createdAt: block.timestamp
        });
        _beneficiaryClaims[beneficiary].push(claimId);

        emit ClaimCreated(claimId, beneficiary, token, amount);
        return claimId;
    }

    /// @notice Set the treasury steward (governance only).
    /// @dev Does not reset the budget window or spending. The new steward inherits the
    /// current period's remaining budget and timing.
    function setSteward(address _steward) external onlyOwner {
        emit StewardUpdated(steward, _steward);
        steward = _steward;
    }

    // ============ Claim Functions ============

    /// @notice Exercise a claim — beneficiary receives tokens at their discretion
    /// @param claimId Claim to exercise
    /// @param amount Amount to exercise (can be partial)
    function exerciseClaim(uint256 claimId, uint256 amount) external nonReentrant whenNotPaused {
        Claim storage c = claims[claimId];
        require(c.beneficiary == msg.sender, "ArmadaTreasuryGov: not beneficiary");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");
        require(c.exercised + amount <= c.amount, "ArmadaTreasuryGov: exceeds claim");

        c.exercised += amount;
        _checkAndRecordOutflow(c.token, amount);
        IERC20(c.token).safeTransfer(c.beneficiary, amount);

        emit ClaimExercised(claimId, c.beneficiary, amount);
    }

    // ============ Steward Functions ============

    /// @notice Steward: spend from operational budget
    /// @dev The budget is 1% of the treasury balance snapshotted at the start of each 30-day period.
    /// The period starts on the first spend after the previous period expires. Mid-period balance
    /// changes (deposits, governance distributions) do not affect the current period's budget.
    function stewardSpend(address token, address recipient, uint256 amount) external onlySteward whenNotPaused {
        require(recipient != address(0), "ArmadaTreasuryGov: zero address");
        require(amount > 0, "ArmadaTreasuryGov: zero amount");

        // Start a new budget period if the previous one has expired.
        // Snapshot the treasury balance as the basis for this period's 1% cap.
        if (block.timestamp >= lastBudgetReset[token] + BUDGET_PERIOD) {
            budgetSpentThisPeriod[token] = 0;
            lastBudgetReset[token] = block.timestamp;
            budgetBasis[token] = IERC20(token).balanceOf(address(this));
        }

        // Budget for this period: 1% of the snapshotted balance
        uint256 monthlyBudget = (budgetBasis[token] * STEWARD_BUDGET_BPS) / 10000;
        require(
            budgetSpentThisPeriod[token] + amount <= monthlyBudget,
            "ArmadaTreasuryGov: exceeds monthly budget"
        );

        budgetSpentThisPeriod[token] += amount;
        _checkAndRecordOutflow(token, amount);
        IERC20(token).safeTransfer(recipient, amount);

        uint256 remaining = monthlyBudget - budgetSpentThisPeriod[token];
        emit StewardSpent(token, recipient, amount, remaining);
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

    // ============ View Functions ============

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getBeneficiaryClaims(address beneficiary) external view returns (uint256[] memory) {
        return _beneficiaryClaims[beneficiary];
    }

    function getClaimRemaining(uint256 claimId) external view returns (uint256) {
        Claim storage c = claims[claimId];
        return c.amount - c.exercised;
    }

    /// @notice View the steward's current budget status for a token
    /// @dev If the period has expired, returns what the budget *would* be if a new period
    /// started now (based on current balance). During an active period, returns the
    /// snapshotted budget basis.
    function getStewardBudget(address token) external view returns (uint256 budget, uint256 spent, uint256 remaining) {
        if (block.timestamp >= lastBudgetReset[token] + BUDGET_PERIOD) {
            // Period expired — show what the next period's budget would be
            uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
            budget = (treasuryBalance * STEWARD_BUDGET_BPS) / 10000;
            spent = 0;
        } else {
            // Active period — use snapshotted basis
            budget = (budgetBasis[token] * STEWARD_BUDGET_BPS) / 10000;
            spent = budgetSpentThisPeriod[token];
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

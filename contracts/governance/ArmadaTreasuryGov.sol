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
    ///
    /// Each of the three governance-tunable knobs (windowDuration, limitBps, limitAbsolute)
    /// has a paired pending slot. Governance changes that LOOSEN spending capacity are
    /// written to the pending slot and only take effect after LIMIT_ACTIVATION_DELAY
    /// elapses. Changes that TIGHTEN take effect immediately and clear the matching
    /// pending slot. See _lazyActivate and the three setters for the activation rules.
    struct OutflowConfig {
        uint256 windowDuration;   // rolling window in seconds (e.g. 30 days)
        uint256 limitBps;         // percentage of current treasury balance (1000 = 10%)
        uint256 limitAbsolute;    // absolute cap in token units
        uint256 floorAbsolute;    // immutable minimum — governance can never reduce below this
        bool initialized;         // whether config has been set for this token

        // Pending-activation slots for loosening changes.
        // activation == 0 means no pending change. activation > 0 means the stored
        // pending* value becomes active at that timestamp. Loosening direction is
        // parameter-specific: Absolute/Bps loosen on increase; WindowDuration loosens
        // on decrease (shorter lookback = faster budget refresh).
        uint256 pendingLimitAbsolute;
        uint256 pendingLimitAbsoluteActivation;
        uint256 pendingLimitBps;
        uint256 pendingLimitBpsActivation;
        uint256 pendingWindowDuration;
        uint256 pendingWindowDurationActivation;
    }

    /// @notice Record of a single outflow event, used for rolling window accounting.
    struct OutflowRecord {
        uint256 amount;
        uint256 timestamp;
    }

    // ============ State ============

    address public immutable owner; // TimelockController address (set once at deployment, cannot be changed)

    /// @notice Delay applied to outflow-loosening parameter changes before they take effect.
    /// @dev Must strictly exceed the maximum Extended-proposal governance cycle
    ///      (proposalDelay + votingPeriod + executionDelay). ArmadaGovernor.setProposalTypeParams
    ///      enforces this invariant at setter time so a captured governance cannot stretch
    ///      the Extended cycle to exceed this delay and bypass the defense.
    ///      24 days > 23 days (current Extended default: 2d + 14d + 7d).
    ///      medi-Sepolia: 16 days > 4.25 days (Extended default: 6h + 3d + 1d) — defense preserved.
    uint256 public constant LIMIT_ACTIVATION_DELAY = 16 days; // (medi-Sepolia)

    // Per-token steward budget table (governance-managed via Extended proposals).
    // Each authorized token has an absolute spending limit per rolling window.
    // Unused budget does not carry over between windows.
    struct StewardBudget {
        uint256 limit;         // max spend per window in token units
        uint256 window;        // window duration in seconds
        bool authorized;       // whether steward can spend this token
    }

    mapping(address => StewardBudget) public stewardBudgets;
    mapping(address => OutflowRecord[]) internal _stewardSpendHistory;

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

    // Absolute limit: loosening = increase. Scheduled → activates at activatesAt.
    event OutflowLimitAbsoluteIncreaseScheduled(address indexed token, uint256 oldActive, uint256 pendingValue, uint256 activatesAt);
    event OutflowLimitAbsoluteActivated(address indexed token, uint256 oldActive, uint256 newActive);
    event OutflowLimitAbsoluteDecreased(address indexed token, uint256 oldActive, uint256 newActive);

    // Bps limit: loosening = increase.
    event OutflowLimitBpsIncreaseScheduled(address indexed token, uint256 oldActive, uint256 pendingValue, uint256 activatesAt);
    event OutflowLimitBpsActivated(address indexed token, uint256 oldActive, uint256 newActive);
    event OutflowLimitBpsDecreased(address indexed token, uint256 oldActive, uint256 newActive);

    // Window duration: loosening = decrease (shorter lookback drops older outflow records
    // from the rolling sum faster, freeing budget sooner). Semantics are inverted vs. the
    // limit parameters by design — this is not a bug. See _sumRecentRecords.
    event OutflowWindowDurationDecreaseScheduled(address indexed token, uint256 oldActive, uint256 pendingValue, uint256 activatesAt);
    event OutflowWindowDurationActivated(address indexed token, uint256 oldActive, uint256 newActive);
    event OutflowWindowDurationIncreased(address indexed token, uint256 oldActive, uint256 newActive);
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

        // Rolling window: sum all steward spends within the trailing window
        uint256 recentSpend = _sumRecentRecords(_stewardSpendHistory[token], budget.window);
        require(
            recentSpend + amount <= budget.limit,
            "ArmadaTreasuryGov: exceeds steward budget"
        );

        // Record this spend for rolling window tracking.
        // NOTE: Same append-only pattern as _outflowHistory — see design note on _checkAndRecordOutflow.
        _stewardSpendHistory[token].push(OutflowRecord({
            amount: amount,
            timestamp: block.timestamp
        }));

        _checkAndRecordOutflow(token, amount);
        IERC20(token).safeTransfer(recipient, amount);

        uint256 remaining = budget.limit - (recentSpend + amount);
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
        delete _stewardSpendHistory[token];

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
        require(limitBps > 0, "ArmadaTreasuryGov: zero bps");
        require(limitBps <= 10000, "ArmadaTreasuryGov: bps out of range");
        require(limitAbsolute >= floorAbsolute, "ArmadaTreasuryGov: absolute below floor");

        _outflowConfigs[token] = OutflowConfig({
            windowDuration: windowDuration,
            limitBps: limitBps,
            limitAbsolute: limitAbsolute,
            floorAbsolute: floorAbsolute,
            initialized: true,
            pendingLimitAbsolute: 0,
            pendingLimitAbsoluteActivation: 0,
            pendingLimitBps: 0,
            pendingLimitBpsActivation: 0,
            pendingWindowDuration: 0,
            pendingWindowDurationActivation: 0
        });

        emit OutflowConfigInitialized(token, windowDuration, limitBps, limitAbsolute, floorAbsolute);
    }

    /// @notice Update the rolling window duration for a token's outflow limit.
    /// @dev Loosening (newWindow < active) goes to a pending slot with a LIMIT_ACTIVATION_DELAY
    ///      timer; a later overlapping call overwrites the pending value and resets the timer.
    ///      Tightening or no-op (newWindow >= active) takes effect immediately and clears any
    ///      pending decrease. Direction is measured against the active window after lazy
    ///      activation, not against any currently-pending value — see issue #226 edge case.
    function setOutflowWindow(address token, uint256 newWindow) external onlyOwner {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow not initialized");
        require(newWindow >= 1 days, "ArmadaTreasuryGov: window too short");

        _lazyActivate(token);
        OutflowConfig storage config = _outflowConfigs[token];
        uint256 activeWindow = config.windowDuration;

        if (newWindow < activeWindow) {
            // Loosening: shorter lookback would drop records and free budget faster — delay.
            uint256 activatesAt = block.timestamp + LIMIT_ACTIVATION_DELAY;
            config.pendingWindowDuration = newWindow;
            config.pendingWindowDurationActivation = activatesAt;
            emit OutflowWindowDurationDecreaseScheduled(token, activeWindow, newWindow, activatesAt);
        } else {
            // Tightening or no-op: immediate, clears any pending loosening.
            config.windowDuration = newWindow;
            config.pendingWindowDuration = 0;
            config.pendingWindowDurationActivation = 0;
            emit OutflowWindowDurationIncreased(token, activeWindow, newWindow);
        }
    }

    /// @notice Update the percentage-based outflow limit for a token.
    /// @dev Loosening (newBps > active) goes to a pending slot with a LIMIT_ACTIVATION_DELAY
    ///      timer; a later overlapping call overwrites the pending value and resets the timer.
    ///      Tightening or no-op (newBps <= active) takes effect immediately and clears any
    ///      pending increase.
    function setOutflowLimitBps(address token, uint256 newBps) external onlyOwner {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow not initialized");
        require(newBps > 0, "ArmadaTreasuryGov: zero bps");
        require(newBps <= 10000, "ArmadaTreasuryGov: bps out of range");

        _lazyActivate(token);
        OutflowConfig storage config = _outflowConfigs[token];
        uint256 activeBps = config.limitBps;

        if (newBps > activeBps) {
            uint256 activatesAt = block.timestamp + LIMIT_ACTIVATION_DELAY;
            config.pendingLimitBps = newBps;
            config.pendingLimitBpsActivation = activatesAt;
            emit OutflowLimitBpsIncreaseScheduled(token, activeBps, newBps, activatesAt);
        } else {
            config.limitBps = newBps;
            config.pendingLimitBps = 0;
            config.pendingLimitBpsActivation = 0;
            emit OutflowLimitBpsDecreased(token, activeBps, newBps);
        }
    }

    /// @notice Update the absolute outflow limit for a token. Cannot be set below floor.
    /// @dev Loosening (newAbsolute > active) goes to a pending slot with a LIMIT_ACTIVATION_DELAY
    ///      timer; a later overlapping call overwrites the pending value and resets the timer.
    ///      Tightening or no-op (newAbsolute <= active) takes effect immediately and clears any
    ///      pending increase. The floor check applies to the new value regardless of direction.
    function setOutflowLimitAbsolute(address token, uint256 newAbsolute) external onlyOwner {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow not initialized");
        require(newAbsolute >= _outflowConfigs[token].floorAbsolute, "ArmadaTreasuryGov: absolute below floor");

        _lazyActivate(token);
        OutflowConfig storage config = _outflowConfigs[token];
        uint256 activeAbsolute = config.limitAbsolute;

        if (newAbsolute > activeAbsolute) {
            uint256 activatesAt = block.timestamp + LIMIT_ACTIVATION_DELAY;
            config.pendingLimitAbsolute = newAbsolute;
            config.pendingLimitAbsoluteActivation = activatesAt;
            emit OutflowLimitAbsoluteIncreaseScheduled(token, activeAbsolute, newAbsolute, activatesAt);
        } else {
            config.limitAbsolute = newAbsolute;
            config.pendingLimitAbsolute = 0;
            config.pendingLimitAbsoluteActivation = 0;
            emit OutflowLimitAbsoluteDecreased(token, activeAbsolute, newAbsolute);
        }
    }

    /// @notice Permissionless trigger to activate any pending outflow parameter changes
    ///         whose activation timestamps have elapsed. No-op if nothing is due.
    /// @dev Intended for monitoring bots and operational tooling that want to emit the
    ///      OutflowLimit*Activated event at the activation timestamp rather than waiting
    ///      for the next distribute/stewardSpend call. Does not revert, does not modify
    ///      state if nothing is due.
    function activatePendingOutflowParams(address token) external {
        _lazyActivate(token);
    }

    // ============ Internal: Lazy Activation ============

    /// @dev Promote any pending outflow parameter values whose activation timestamps have
    ///      elapsed. Must be called at the top of every code path that reads an outflow
    ///      parameter for enforcement (currently: _checkAndRecordOutflow and the three
    ///      setOutflow* setters). Missing this call in a future code path would silently
    ///      enforce stale values — the single most important correctness check.
    function _lazyActivate(address token) internal {
        OutflowConfig storage config = _outflowConfigs[token];

        if (config.pendingLimitAbsoluteActivation > 0 &&
            block.timestamp >= config.pendingLimitAbsoluteActivation) {
            uint256 oldActive = config.limitAbsolute;
            uint256 newActive = config.pendingLimitAbsolute;
            config.limitAbsolute = newActive;
            config.pendingLimitAbsolute = 0;
            config.pendingLimitAbsoluteActivation = 0;
            emit OutflowLimitAbsoluteActivated(token, oldActive, newActive);
        }

        if (config.pendingLimitBpsActivation > 0 &&
            block.timestamp >= config.pendingLimitBpsActivation) {
            uint256 oldActive = config.limitBps;
            uint256 newActive = config.pendingLimitBps;
            config.limitBps = newActive;
            config.pendingLimitBps = 0;
            config.pendingLimitBpsActivation = 0;
            emit OutflowLimitBpsActivated(token, oldActive, newActive);
        }

        if (config.pendingWindowDurationActivation > 0 &&
            block.timestamp >= config.pendingWindowDurationActivation) {
            uint256 oldActive = config.windowDuration;
            uint256 newActive = config.pendingWindowDuration;
            config.windowDuration = newActive;
            config.pendingWindowDuration = 0;
            config.pendingWindowDurationActivation = 0;
            emit OutflowWindowDurationActivated(token, oldActive, newActive);
        }
    }

    // ============ Internal: Outflow Enforcement ============

    /// @dev Check that a proposed outflow does not exceed the rolling-window limit,
    ///      and record the outflow if it passes. Reverts if no outflow config is initialized for the token.
    ///
    ///      DESIGN NOTE: _outflowHistory[token] is append-only and never pruned. Storage grows
    ///      monotonically with the number of outflows. This is acceptable because:
    ///      (1) _sumRecentRecords iterates backwards with early-break, so read cost is bounded
    ///          by the number of records within the rolling window, not total array length.
    ///      (2) Realistic usage (~1 distribution/week) produces ~260 records/year per token.
    ///      (3) Steward spends (~daily) produce ~365 records/year — still manageable.
    ///      If usage patterns change significantly, a pruning mechanism could be added.
    function _checkAndRecordOutflow(address token, uint256 amount) internal {
        require(_outflowConfigs[token].initialized, "ArmadaTreasuryGov: outflow config required");

        // Promote any pending loosenings whose timers have elapsed BEFORE enforcement reads
        // the parameters. Without this, a drain executed in the same block as a just-activated
        // loosening would still enforce the stale pre-loosening limit.
        _lazyActivate(token);

        OutflowConfig storage config = _outflowConfigs[token];
        uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
        uint256 effectiveLimit = _effectiveLimit(config, treasuryBalance);

        // Sum recent outflows within the rolling window
        uint256 recentOutflow = _sumRecentRecords(_outflowHistory[token], config.windowDuration);

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

    /// @dev Sum amounts within a rolling window, iterating backwards from most recent.
    ///      DESIGN NOTE: The underlying arrays (_outflowHistory, _stewardSpendHistory) are
    ///      append-only and never pruned. Storage grows monotonically, but gas cost of this
    ///      function is proportional to records WITHIN the window only (not total array length),
    ///      thanks to the backwards iteration with early-break. At realistic usage rates
    ///      (~1 distribution/week ≈ 260 records/year), growth is bounded and manageable.
    ///      If usage patterns change significantly, consider adding a pruning mechanism.
    function _sumRecentRecords(OutflowRecord[] storage records, uint256 windowDuration) internal view returns (uint256 total) {
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

    /// @dev Calculate effective outflow limit: max(pct of balance, absolute), then max(result, floor).
    function _effectiveLimit(OutflowConfig storage config, uint256 treasuryBalance) internal view returns (uint256) {
        uint256 pctLimit = (treasuryBalance * config.limitBps) / 10000;
        uint256 limit = pctLimit > config.limitAbsolute ? pctLimit : config.limitAbsolute;
        return limit > config.floorAbsolute ? limit : config.floorAbsolute;
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
        spent = _sumRecentRecords(_stewardSpendHistory[token], b.window);
        remaining = budget > spent ? budget - spent : 0;
    }

    /// @notice Get the RAW stored outflow configuration for a token (pre-lazy-activation).
    /// @dev Returns the literal storage values. For values that reflect enforcement behavior
    ///      (i.e. what the next distribute/stewardSpend call would enforce), use
    ///      getEffectiveOutflowConfig instead. Kept for debugging and monitoring that needs
    ///      to distinguish scheduled-but-not-yet-activated pending values from stale storage.
    function getOutflowConfig(address token) external view returns (
        uint256 windowDuration,
        uint256 limitBps,
        uint256 limitAbsolute,
        uint256 floorAbsolute
    ) {
        OutflowConfig storage config = _outflowConfigs[token];
        return (config.windowDuration, config.limitBps, config.limitAbsolute, config.floorAbsolute);
    }

    /// @notice Get the effective outflow configuration that would apply right now to a
    ///         distribute or stewardSpend call (i.e. after lazy activation of any pending
    ///         values whose timers have elapsed). View counterpart of _lazyActivate.
    /// @dev Must return identical values to what _lazyActivate would produce if called now.
    ///      Cyfrin verifies this parity as part of the delay-mechanism audit.
    function getEffectiveOutflowConfig(address token) external view returns (
        uint256 windowDuration,
        uint256 limitBps,
        uint256 limitAbsolute,
        uint256 floorAbsolute
    ) {
        OutflowConfig storage config = _outflowConfigs[token];
        (windowDuration, limitBps, limitAbsolute) = _effectiveParams(config);
        floorAbsolute = config.floorAbsolute;
    }

    /// @notice Get the pending (not-yet-activated) outflow parameter state for a token.
    ///         Each activation timestamp is 0 if no change is pending for that parameter.
    /// @dev Intended for monitoring frontends so users can see upcoming loosenings.
    function getPendingOutflowConfig(address token) external view returns (
        uint256 pendingWindowDuration,
        uint256 pendingWindowDurationActivation,
        uint256 pendingLimitBps,
        uint256 pendingLimitBpsActivation,
        uint256 pendingLimitAbsolute,
        uint256 pendingLimitAbsoluteActivation
    ) {
        OutflowConfig storage config = _outflowConfigs[token];
        return (
            config.pendingWindowDuration,
            config.pendingWindowDurationActivation,
            config.pendingLimitBps,
            config.pendingLimitBpsActivation,
            config.pendingLimitAbsolute,
            config.pendingLimitAbsoluteActivation
        );
    }

    /// @notice Get the current outflow status for a token: effective limit, recent outflow, and available.
    /// @dev Uses post-lazy-activation values so the reported `available` matches what the next
    ///      distribute/stewardSpend call would actually enforce.
    function getOutflowStatus(address token) external view returns (
        uint256 effectiveLimit,
        uint256 recentOutflow,
        uint256 available
    ) {
        OutflowConfig storage config = _outflowConfigs[token];
        if (!config.initialized) return (0, 0, 0);

        (uint256 effWindow, uint256 effBps, uint256 effAbsolute) = _effectiveParams(config);

        uint256 treasuryBalance = IERC20(token).balanceOf(address(this));
        uint256 pctLimit = (treasuryBalance * effBps) / 10000;
        uint256 limit = pctLimit > effAbsolute ? pctLimit : effAbsolute;
        effectiveLimit = limit > config.floorAbsolute ? limit : config.floorAbsolute;

        recentOutflow = _sumRecentRecords(_outflowHistory[token], effWindow);
        available = effectiveLimit > recentOutflow ? effectiveLimit - recentOutflow : 0;
    }

    /// @dev View-only computation of effective outflow parameters: mirrors _lazyActivate
    ///      without mutating state. Returns (windowDuration, limitBps, limitAbsolute) that
    ///      would be active right now.
    function _effectiveParams(OutflowConfig storage config) internal view returns (
        uint256 effWindowDuration,
        uint256 effLimitBps,
        uint256 effLimitAbsolute
    ) {
        effLimitAbsolute = (config.pendingLimitAbsoluteActivation > 0 &&
            block.timestamp >= config.pendingLimitAbsoluteActivation)
            ? config.pendingLimitAbsolute : config.limitAbsolute;

        effLimitBps = (config.pendingLimitBpsActivation > 0 &&
            block.timestamp >= config.pendingLimitBpsActivation)
            ? config.pendingLimitBps : config.limitBps;

        effWindowDuration = (config.pendingWindowDurationActivation > 0 &&
            block.timestamp >= config.pendingWindowDurationActivation)
            ? config.pendingWindowDuration : config.windowDuration;
    }
}

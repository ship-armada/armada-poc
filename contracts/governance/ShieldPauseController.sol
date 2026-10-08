// SPDX-License-Identifier: MIT
// ABOUTME: Shield pause controller; the SC pause is disabled (zero duration), wind-down modes remain.
// ABOUTME: Reads SC address from governor; supports post-wind-down single-pause behavior.
pragma solidity ^0.8.17;

import "./IShieldPauseController.sol";

/// @notice Minimal interface to read securityCouncil from ArmadaGovernor
interface IArmadaGovernorSC {
    function securityCouncil() external view returns (address);
}

/// @title ShieldPauseController — wind-down shield modes; SC pause disabled
/// @notice MAX_PAUSE_DURATION is zero, so an SC pause expires in the block it is made:
///         `pauseShields()` succeeds and emits `ShieldsPaused`, but shields are never
///         actually paused by the SC, before or after wind-down (`emergencyPaused()` is
///         always false). Wind-down behaviour is unaffected: once wind-down is active,
///         `shieldsPaused()` and `withdrawOnlyMode()` are permanently true.
///
///         The SC address is read from the ArmadaGovernor contract, so changes to
///         the governor's securityCouncil (including ejection via denied veto) are
///         automatically reflected here without a separate setter.
///
///         Post-wind-down behavior: the SC can invoke exactly one pause. After that
///         pause expires or is lifted, no further pauses are possible. This prevents
///         indefinite pausing without governance accountability (since governance is
///         disabled after wind-down).
contract ShieldPauseController is IShieldPauseController {

    // ============ State ============

    /// @notice Governor contract (reads securityCouncil from here)
    IArmadaGovernorSC public immutable governor;

    /// @notice Timelock address (governance authority for early unpause)
    address public immutable pauseTimelock;

    /// @notice SC pause duration. Zero disables the SC pause: a pause expires in the block it is made.
    uint256 public constant MAX_PAUSE_DURATION = 0;

    // Pack 4 bools + address into one slot (audit-68): 4 + 20 = 24 bytes.
    /// @notice Whether shields are paused (internal flag — use shieldsPaused() for auto-expiry)
    bool private _paused;
    /// @notice Whether the wind-down has been activated
    bool public windDownActive;
    /// @notice Whether the wind-down contract has been set (one-time setter lock)
    bool public windDownContractSet;
    /// @notice Whether the single post-wind-down pause has been consumed
    bool public windDownPauseUsed;
    /// @notice Wind-down contract address (only this address can call setWindDownActive)
    address public windDownContract;

    /// @notice Timestamp when the current pause expires (0 if not paused)
    uint256 public pauseExpiry;

    // ============ Events ============

    event ShieldsPaused(address indexed securityCouncil, uint256 expiry);
    event ShieldsUnpaused(address indexed caller);
    event WindDownContractSet(address indexed windDownContract);
    event WindDownActivated();

    // ============ Constructor ============

    /// @param _governor ArmadaGovernor contract (reads SC address from here)
    /// @param _pauseTimelock Timelock address for governance unpause
    constructor(address _governor, address _pauseTimelock) {
        require(_governor != address(0), "ShieldPauseController: zero governor");
        require(_pauseTimelock != address(0), "ShieldPauseController: zero timelock");

        governor = IArmadaGovernorSC(_governor);
        pauseTimelock = _pauseTimelock;
    }

    // ============ View Functions ============

    /// @notice Returns true if shields are paused.
    ///         Post-wind-down: permanently true (withdraw-only mode per spec).
    ///         Pre-wind-down: true only during an active SC pause (never, with a zero MAX_PAUSE_DURATION).
    function shieldsPaused() external view override returns (bool) {
        if (windDownActive) return true;
        return _paused && block.timestamp < pauseExpiry;
    }

    /// @notice Returns true if pool is in withdraw-only mode (wind-down active).
    ///         When true, only unshields are allowed — shields and private transfers are blocked.
    ///         SC pause does NOT activate withdraw-only mode (SC pause only affects shields).
    function withdrawOnlyMode() external view override returns (bool) {
        return windDownActive;
    }

    /// @notice Returns true during the post-wind-down SC emergency pause (a single,
    ///         non-renewable MAX_PAUSE_DURATION window that would also block unshields).
    ///         With a zero MAX_PAUSE_DURATION this is always false. Pre-wind-down it is
    ///         always false regardless — unshields are never affected by normal SC pauses.
    function emergencyPaused() external view override returns (bool) {
        return windDownActive && _isPaused();
    }

    // ============ Security Council Functions ============

    /// @notice SC triggers shield pause. Auto-expires after MAX_PAUSE_DURATION (zero: same block).
    ///         Pre-wind-down: SC can re-invoke after expiry (unlimited).
    ///         Post-wind-down: exactly one invocation allowed.
    function pauseShields() external {
        // sc != address(0) check is redundant: msg.sender is never address(0) in
        // EVM, so msg.sender == sc already implies sc != address(0). Pre-launch
        // (governor.securityCouncil() == 0) is rejected by the first conjunct alone.
        address sc = governor.securityCouncil();
        require(msg.sender == sc, "ShieldPauseController: not SC");
        require(!_isPaused(), "ShieldPauseController: already paused");

        if (windDownActive) {
            require(!windDownPauseUsed, "ShieldPauseController: post-wind-down pause already used");
            windDownPauseUsed = true;
        }

        _paused = true;
        // Compute expiry into a local first to avoid SLOAD in the emit (audit-76).
        uint256 expiry = block.timestamp + MAX_PAUSE_DURATION;
        pauseExpiry = expiry;
        emit ShieldsPaused(msg.sender, expiry);
    }

    // ============ Governance Functions ============

    /// @notice Governance (timelock) can unpause shields at any time
    function unpauseShields() external {
        require(msg.sender == pauseTimelock, "ShieldPauseController: not timelock");
        require(_isPaused(), "ShieldPauseController: not paused");
        _paused = false;
        pauseExpiry = 0;
        emit ShieldsUnpaused(msg.sender);
    }

    /// @notice Set the wind-down contract address. One-time setter, timelock-only.
    function setWindDownContract(address _windDownContract) external {
        require(msg.sender == pauseTimelock, "ShieldPauseController: not timelock");
        // Parameter check before cold SLOAD on the lock flag (audit-79).
        require(_windDownContract != address(0), "ShieldPauseController: zero address");
        require(!windDownContractSet, "ShieldPauseController: wind-down already set");
        windDownContractSet = true;
        windDownContract = _windDownContract;
        emit WindDownContractSet(_windDownContract);
    }

    // ============ Wind-Down Functions ============

    /// @notice Called by the wind-down contract to activate withdraw-only mode.
    ///         Shields are permanently disabled; unshields remain available indefinitely.
    /// @dev If a pre-trigger SC pause is still active when wind-down fires, that pause
    ///      consumes the single post-wind-down pause budget. Without this, an SC pause
    ///      issued just before triggerWindDown would block unshields via emergencyPaused
    ///      for its remaining duration AND leave the post-trigger pause untouched, enabling
    ///      a chained unshield block of up to twice MAX_PAUSE_DURATION. With this, total
    ///      continuous unshield blocking across the trigger is bounded by the residual of
    ///      the active pre-trigger pause (≤ MAX_PAUSE_DURATION).
    function setWindDownActive() external {
        require(msg.sender == windDownContract, "ShieldPauseController: not wind-down contract");
        require(!windDownActive, "ShieldPauseController: wind-down already active");
        windDownActive = true;
        if (_isPaused()) {
            windDownPauseUsed = true;
        }
        emit WindDownActivated();
    }

    // ============ Internal ============

    /// @notice Check if currently paused (accounting for auto-expiry)
    function _isPaused() internal view returns (bool) {
        return _paused && block.timestamp < pauseExpiry;
    }
}

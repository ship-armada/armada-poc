// SPDX-License-Identifier: MIT
// ABOUTME: Security Council shield pause controller with 24h auto-expiry.
// ABOUTME: Reads SC address from governor; supports post-wind-down single-pause behavior.
pragma solidity ^0.8.17;

import "./IShieldPauseController.sol";

/// @notice Minimal interface to read securityCouncil from ArmadaGovernor
interface IArmadaGovernorSC {
    function securityCouncil() external view returns (address);
}

/// @title ShieldPauseController — SC-triggered shield pause with auto-expiry
/// @notice The Security Council can pause shield operations for up to 24 hours.
///         The pause auto-expires — the SC cannot permanently freeze shields.
///         Unshields are never affected by this pause.
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

    /// @notice Maximum pause duration (24 hours)
    uint256 public constant MAX_PAUSE_DURATION = 24 hours;

    /// @notice Whether shields are paused (internal flag — use shieldsPaused() for auto-expiry)
    bool private _paused;

    /// @notice Timestamp when the current pause expires (0 if not paused)
    uint256 public pauseExpiry;

    /// @notice Whether the wind-down has been activated
    bool public windDownActive;

    /// @notice Wind-down contract address (only this address can call setWindDownActive)
    address public windDownContract;

    /// @notice Whether the wind-down contract has been set (one-time setter lock)
    bool public windDownContractSet;

    /// @notice Whether the single post-wind-down pause has been consumed
    bool public windDownPauseUsed;

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
    ///         Pre-wind-down: true only during an active SC pause (24h auto-expiry).
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

    /// @notice Returns true during the post-wind-down SC emergency pause.
    ///         This is the only scenario where unshields can be paused: a single 24h
    ///         non-renewable window to protect users from adapter issues after wind-down.
    ///         Pre-wind-down this always returns false — unshields are never affected by
    ///         normal SC pauses.
    function emergencyPaused() external view override returns (bool) {
        return windDownActive && _isPaused();
    }

    // ============ Security Council Functions ============

    /// @notice SC triggers shield pause. Auto-expires after 24 hours.
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
    ///      for its remaining 24h AND leave the post-trigger pause untouched, enabling
    ///      a chained ~48h unshield block. With this, total continuous unshield blocking
    ///      across the trigger is bounded by the residual of the active pre-trigger
    ///      pause (≤24h).
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

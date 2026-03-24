// ABOUTME: Security Council shield pause controller with 24h auto-expiry.
// ABOUTME: Reads SC address from governor; supports post-wind-down single-pause behavior.

// SPDX-License-Identifier: MIT
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

    /// @notice Returns true only if paused AND the pause has not expired
    function shieldsPaused() external view override returns (bool) {
        return _paused && block.timestamp < pauseExpiry;
    }

    // ============ Security Council Functions ============

    /// @notice SC triggers shield pause. Auto-expires after 24 hours.
    ///         Pre-wind-down: SC can re-invoke after expiry (unlimited).
    ///         Post-wind-down: exactly one invocation allowed.
    function pauseShields() external {
        address sc = governor.securityCouncil();
        require(msg.sender == sc && sc != address(0), "ShieldPauseController: not SC");
        require(!_isPaused(), "ShieldPauseController: already paused");

        if (windDownActive) {
            require(!windDownPauseUsed, "ShieldPauseController: post-wind-down pause already used");
            windDownPauseUsed = true;
        }

        _paused = true;
        pauseExpiry = block.timestamp + MAX_PAUSE_DURATION;
        emit ShieldsPaused(msg.sender, pauseExpiry);
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
        require(!windDownContractSet, "ShieldPauseController: wind-down already set");
        require(_windDownContract != address(0), "ShieldPauseController: zero address");
        windDownContractSet = true;
        windDownContract = _windDownContract;
        emit WindDownContractSet(_windDownContract);
    }

    // ============ Wind-Down Functions ============

    /// @notice Called by the wind-down contract to activate post-wind-down pause restrictions
    function setWindDownActive() external {
        require(msg.sender == windDownContract, "ShieldPauseController: not wind-down contract");
        require(windDownContract != address(0), "ShieldPauseController: wind-down not set");
        require(!windDownActive, "ShieldPauseController: wind-down already active");
        windDownActive = true;
        emit WindDownActivated();
    }

    // ============ Internal ============

    /// @notice Check if currently paused (accounting for auto-expiry)
    function _isPaused() internal view returns (bool) {
        return _paused && block.timestamp < pauseExpiry;
    }
}

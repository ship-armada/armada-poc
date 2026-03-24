// ABOUTME: Interface for shield pause controller, consumed by PrivacyPool's ShieldModule.
// ABOUTME: Exposes a single view function to check if shields are currently paused.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title IShieldPauseController — Minimal interface for shield pause status
/// @notice The PrivacyPool's ShieldModule checks this to determine if shields are paused.
interface IShieldPauseController {
    /// @notice Returns true if shields are currently paused (accounting for auto-expiry)
    function shieldsPaused() external view returns (bool);
}

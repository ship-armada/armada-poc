// SPDX-License-Identifier: MIT
// ABOUTME: Interface for shield pause controller, consumed by PrivacyPool's ShieldModule.
// ABOUTME: Exposes view functions to check shield pause state and withdraw-only mode.
pragma solidity ^0.8.17;

/// @title IShieldPauseController — Minimal interface for shield pause status
/// @notice The PrivacyPool's ShieldModule checks this to determine if shields are paused.
///         TransactModule checks withdrawOnlyMode() to block private transfers after wind-down.
interface IShieldPauseController {
    /// @notice Returns true if shields are currently paused (accounting for auto-expiry)
    function shieldsPaused() external view returns (bool);

    /// @notice Returns true if the pool is in withdraw-only mode (wind-down active).
    ///         When true, only unshields are allowed — private transfers are blocked.
    ///         Distinct from shieldsPaused(): SC pause does NOT activate withdraw-only mode.
    function withdrawOnlyMode() external view returns (bool);
}

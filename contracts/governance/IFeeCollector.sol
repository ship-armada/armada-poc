// SPDX-License-Identifier: MIT
// ABOUTME: Interface for fee collector contracts that report cumulative fees collected.
// ABOUTME: Used by RevenueCounter to sync on-chain revenue from protocol fee sources.
pragma solidity ^0.8.17;

/// @title IFeeCollector — Interface for fee-reporting contracts
/// @notice Any contract that collects protocol fees and exposes a monotonic cumulative counter.
interface IFeeCollector {
    /// @notice Returns the total cumulative fees collected (in the fee token's native decimals).
    /// @dev Must be monotonically non-decreasing. RevenueCounter reads the delta since last sync.
    function cumulativeFeesCollected() external view returns (uint256);
}

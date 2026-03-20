// SPDX-License-Identifier: MIT
// ABOUTME: Mock implementation of IFeeCollector for testing RevenueCounter.
// ABOUTME: Allows test scripts to set arbitrary cumulative fee values.
pragma solidity ^0.8.17;

import "./IFeeCollector.sol";

/// @title MockFeeCollector — Test-only fee collector with settable cumulative fees
contract MockFeeCollector is IFeeCollector {
    uint256 private _cumulativeFees;

    function setCumulativeFees(uint256 newCumulative) external {
        _cumulativeFees = newCumulative;
    }

    function cumulativeFeesCollected() external view override returns (uint256) {
        return _cumulativeFees;
    }
}

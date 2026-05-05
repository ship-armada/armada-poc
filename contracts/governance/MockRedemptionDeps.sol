// SPDX-License-Identifier: MIT
// ABOUTME: Test-only mocks of RevenueLock and Crowdfund views consumed by ArmadaRedemption.
// ABOUTME: Used by Hardhat redemption integration tests in lieu of deploying the full contracts.
pragma solidity ^0.8.17;

/// @title MockRevenueLockRedemption — test mock for ArmadaRedemption integration
/// @notice Implements only `lockedAtWindDown()` and `freezeAtWindDown()`. Tests configure
///         the locked-at-wind-down value directly via setLocked. The freeze hook is a
///         no-op stub so that ArmadaWindDown's trigger flow can call into it.
contract MockRevenueLockRedemption {
    uint256 public lockedAtWindDown;
    bool public frozenAtWindDown;

    function setLocked(uint256 v) external {
        lockedAtWindDown = v;
    }

    function freezeAtWindDown() external {
        frozenAtWindDown = true;
    }
}

/// @title MockCrowdfundRedemption — test mock for ArmadaRedemption integration
/// @notice Implements only `armStillOwed()`. Tests configure the value directly via
///         setStillOwed to model entitled-unclaimed scenarios.
contract MockCrowdfundRedemption {
    uint256 public armStillOwed;

    function setStillOwed(uint256 v) external {
        armStillOwed = v;
    }
}

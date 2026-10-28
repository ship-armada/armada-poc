// SPDX-License-Identifier: MIT
// ABOUTME: Test-only fee module whose calculateShieldFee returns whatever split the test sets,
// ABOUTME: so pool tests can feed it inconsistent or excessive fees. Never deploy outside tests.
pragma solidity ^0.8.17;

/// @title ConfigurableFeeModule
/// @notice Implements only the two fee-module calls the pool's shield path makes:
///         `calculateShieldFee` (returns the configured split, ignoring its inputs) and
///         `recordShieldFee` (no-op).
contract ConfigurableFeeModule {
    uint256 public armadaTake;
    uint256 public integratorFee;
    uint256 public totalFee;

    function setSplit(uint256 _armadaTake, uint256 _integratorFee, uint256 _totalFee) external {
        armadaTake = _armadaTake;
        integratorFee = _integratorFee;
        totalFee = _totalFee;
    }

    function calculateShieldFee(address, uint256) external view returns (uint256, uint256, uint256) {
        return (armadaTake, integratorFee, totalFee);
    }

    function recordShieldFee(address, address, uint256, uint256, uint256) external {}
}

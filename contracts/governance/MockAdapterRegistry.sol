// ABOUTME: Test mock for IAdapterRegistry — configurable authorization and withdraw-only flags.
// ABOUTME: Used by yield tests to isolate adapter logic from full governance stack.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title MockAdapterRegistry — Test-only mock for adapter authorization checks
contract MockAdapterRegistry {
    mapping(address => bool) public authorizedAdapters;
    mapping(address => bool) public withdrawOnlyAdapters;

    function setAuthorized(address adapter, bool status) external {
        authorizedAdapters[adapter] = status;
    }

    function setWithdrawOnly(address adapter, bool status) external {
        withdrawOnlyAdapters[adapter] = status;
    }
}

// ABOUTME: Standalone adapter authorization registry for yield adapters.
// ABOUTME: Manages adapter lifecycle (authorized → withdraw-only → fully deauthorized), owned by timelock.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./IArmadaGovernance.sol";

/// @title AdapterRegistry — Yield adapter authorization registry
/// @notice Tracks which yield adapters are authorized to interact with the protocol.
///         Adapters go through a lifecycle: authorized → withdraw-only → fully deauthorized.
///         All state changes require the timelock (governance) as caller.
///         Implements IAdapterRegistry so that ArmadaYieldAdapter can query authorization.
contract AdapterRegistry is IAdapterRegistry {

    // ============ State ============

    /// @notice The timelock controller that owns this registry (set once, immutable).
    address public immutable timelock;

    /// @notice Fully authorized adapters can perform all operations (deposit + withdraw).
    mapping(address => bool) public override authorizedAdapters;

    /// @notice Deauthorized adapters in withdraw-only mode (users can exit positions).
    mapping(address => bool) public override withdrawOnlyAdapters;

    // ============ Events ============

    event AdapterAuthorized(address indexed adapter);
    event AdapterDeauthorized(address indexed adapter);
    event AdapterFullyDeauthorized(address indexed adapter);

    // ============ Constructor ============

    constructor(address _timelock) {
        require(_timelock != address(0), "AdapterRegistry: zero address");
        timelock = _timelock;
    }

    // ============ Adapter Lifecycle ============

    /// @notice Authorize an adapter to interact with the protocol.
    /// Adapters are deployed independently and authorized via standard governance proposal.
    function authorizeAdapter(address adapter) external {
        require(msg.sender == timelock, "AdapterRegistry: not timelock");
        require(adapter != address(0), "AdapterRegistry: zero address");
        require(!authorizedAdapters[adapter], "AdapterRegistry: already authorized");

        authorizedAdapters[adapter] = true;
        withdrawOnlyAdapters[adapter] = false; // Clear withdraw-only in case of re-authorization

        emit AdapterAuthorized(adapter);
    }

    /// @notice Deauthorize an adapter, setting it to withdraw-only mode.
    /// Users can still exit positions through a withdraw-only adapter.
    function deauthorizeAdapter(address adapter) external {
        require(msg.sender == timelock, "AdapterRegistry: not timelock");
        require(adapter != address(0), "AdapterRegistry: zero address");
        require(authorizedAdapters[adapter], "AdapterRegistry: not authorized");

        authorizedAdapters[adapter] = false;
        withdrawOnlyAdapters[adapter] = true;

        emit AdapterDeauthorized(adapter);
    }

    /// @notice Fully remove an adapter after the withdraw-only transition period.
    /// After this, the adapter has no protocol access.
    function fullDeauthorizeAdapter(address adapter) external {
        require(msg.sender == timelock, "AdapterRegistry: not timelock");
        require(adapter != address(0), "AdapterRegistry: zero address");
        require(withdrawOnlyAdapters[adapter], "AdapterRegistry: not withdraw-only");

        withdrawOnlyAdapters[adapter] = false;

        emit AdapterFullyDeauthorized(adapter);
    }
}

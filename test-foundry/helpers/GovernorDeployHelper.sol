// ABOUTME: Shared test helper for deploying ArmadaGovernor behind an ERC1967 UUPS proxy.
// ABOUTME: Used by all Foundry test files that need a governor instance.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../contracts/governance/ArmadaGovernor.sol";
import "../../contracts/governance/UpgradeGate.sol";

abstract contract GovernorDeployHelper {
    /// @dev Deploy ArmadaGovernor implementation + ERC1967Proxy and return the proxied instance.
    ///      Creates an UpgradeGate whose Launch Team is the calling test contract, so tests can
    ///      approve gated proposals directly.
    function _deployGovernorProxy(
        address _armToken,
        address payable _timelock,
        address _treasury
    ) internal returns (ArmadaGovernor) {
        return _deployGovernorProxy(_armToken, _timelock, _treasury, address(new UpgradeGate(address(this))));
    }

    /// @dev Deploy ArmadaGovernor implementation + ERC1967Proxy guarded by the given UpgradeGate.
    function _deployGovernorProxy(
        address _armToken,
        address payable _timelock,
        address _treasury,
        address _upgradeGate
    ) internal returns (ArmadaGovernor) {
        ArmadaGovernor impl = new ArmadaGovernor(_upgradeGate);
        bytes memory initData = abi.encodeWithSelector(
            ArmadaGovernor.initialize.selector,
            _armToken,
            _timelock,
            _treasury
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        ArmadaGovernor governor = ArmadaGovernor(address(proxy));

        // Extended selectors are hardcoded in initialize() — no setup step needed.

        return governor;
    }
}

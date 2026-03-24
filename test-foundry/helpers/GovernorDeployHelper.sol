// ABOUTME: Shared test helper for deploying ArmadaGovernor behind an ERC1967 UUPS proxy.
// ABOUTME: Used by all Foundry test files that need a governor instance.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../contracts/governance/ArmadaGovernor.sol";

abstract contract GovernorDeployHelper {
    /// @dev Deploy ArmadaGovernor implementation + ERC1967Proxy and return the proxied instance.
    function _deployGovernorProxy(
        address _armToken,
        address payable _timelock,
        address _treasury,
        address _guardian,
        uint256 _maxPauseDuration
    ) internal returns (ArmadaGovernor) {
        ArmadaGovernor impl = new ArmadaGovernor();
        bytes memory initData = abi.encodeWithSelector(
            ArmadaGovernor.initialize.selector,
            _armToken,
            _timelock,
            _treasury,
            _guardian,
            _maxPauseDuration
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        return ArmadaGovernor(address(proxy));
    }
}

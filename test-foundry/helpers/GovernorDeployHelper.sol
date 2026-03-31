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
        address _treasury
    ) internal returns (ArmadaGovernor) {
        ArmadaGovernor impl = new ArmadaGovernor();
        bytes memory initData = abi.encodeWithSelector(
            ArmadaGovernor.initialize.selector,
            _armToken,
            _timelock,
            _treasury
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        ArmadaGovernor governor = ArmadaGovernor(address(proxy));

        // Register the initial set of extended selectors (mirrors production deploy)
        bytes4[] memory extSelectors = new bytes4[](12);
        extSelectors[0] = ArmadaGovernor.addExtendedSelector.selector;
        extSelectors[1] = ArmadaGovernor.removeExtendedSelector.selector;
        extSelectors[2] = ArmadaGovernor.setSecurityCouncil.selector;
        extSelectors[3] = ArmadaGovernor.setProposalTypeParams.selector;
        extSelectors[4] = bytes4(keccak256("upgradeTo(address)"));
        extSelectors[5] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        // Yield adapter selectors that require extended governance
        extSelectors[6] = bytes4(keccak256("setBaseArmadaTake(uint256)"));
        extSelectors[7] = bytes4(keccak256("addTier(uint256,uint256)"));
        extSelectors[8] = bytes4(keccak256("setTier(uint256,uint256,uint256)"));
        extSelectors[9] = bytes4(keccak256("removeTier(uint256)"));
        extSelectors[10] = bytes4(keccak256("setYieldFee(uint256)"));
        extSelectors[11] = bytes4(keccak256("setIntegratorTerms(address,uint256,uint256,bool)"));
        governor.initExtendedSelectors(extSelectors);

        return governor;
    }
}

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
        bytes4[] memory extSelectors = new bytes4[](26);
        // Governance parameter changes
        extSelectors[0] = ArmadaGovernor.addExtendedSelector.selector;
        extSelectors[1] = ArmadaGovernor.removeExtendedSelector.selector;
        extSelectors[2] = ArmadaGovernor.setSecurityCouncil.selector;
        extSelectors[3] = ArmadaGovernor.setProposalTypeParams.selector;
        extSelectors[4] = ArmadaGovernor.setWindDownContract.selector;
        // UUPS upgrade selectors
        extSelectors[5] = bytes4(keccak256("upgradeTo(address)"));
        extSelectors[6] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        // Fee parameters (on privacy pool and yield vault)
        extSelectors[7] = bytes4(keccak256("setShieldFee(uint120)"));
        extSelectors[8] = bytes4(keccak256("setUnshieldFee(uint120)"));
        extSelectors[9] = bytes4(keccak256("setYieldFeeBps(uint256)"));
        // Steward election/removal (on TreasurySteward)
        extSelectors[10] = bytes4(keccak256("electSteward(address)"));
        extSelectors[11] = bytes4(keccak256("removeSteward()"));
        // ARM token transfer whitelist
        extSelectors[12] = bytes4(keccak256("addToWhitelist(address)"));
        // Revenue definition expansion (on RevenueCounter)
        extSelectors[13] = bytes4(keccak256("setFeeCollector(address)"));
        // ArmadaFeeModule — fee parameters (per governance spec: all fee changes → Extended)
        extSelectors[14] = bytes4(keccak256("setBaseArmadaTake(uint256)"));
        extSelectors[15] = bytes4(keccak256("addTier(uint256,uint256)"));
        extSelectors[16] = bytes4(keccak256("setTier(uint256,uint256,uint256)"));
        extSelectors[17] = bytes4(keccak256("removeTier(uint256)"));
        extSelectors[18] = bytes4(keccak256("setYieldFee(uint256)"));
        extSelectors[19] = bytes4(keccak256("setIntegratorTerms(address,uint256,uint256,bool)"));
        // Steward budget token management (on ArmadaTreasuryGov)
        extSelectors[20] = bytes4(keccak256("addStewardBudgetToken(address,uint256,uint256)"));
        extSelectors[21] = bytes4(keccak256("updateStewardBudgetToken(address,uint256,uint256)"));
        extSelectors[22] = bytes4(keccak256("removeStewardBudgetToken(address)"));
        // Treasury outflow limit parameters
        extSelectors[23] = bytes4(keccak256("setOutflowWindow(address,uint256)"));
        extSelectors[24] = bytes4(keccak256("setOutflowLimitBps(address,uint256)"));
        extSelectors[25] = bytes4(keccak256("setOutflowLimitAbsolute(address,uint256)"));
        governor.initExtendedSelectors(extSelectors);

        return governor;
    }
}

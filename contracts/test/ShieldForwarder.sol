// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../privacy-pool/interfaces/IPrivacyPool.sol";

/**
 * @title ShieldForwarder
 * @notice Test helper: forwards shield calls to PrivacyPool
 * @dev Used to test privilegedShieldCallers fee exemption
 */
contract ShieldForwarder {
    IPrivacyPool public immutable privacyPool;

    constructor(address _privacyPool) {
        privacyPool = IPrivacyPool(_privacyPool);
    }

    function approveAndShield(address token, uint256 amount, ShieldRequest[] calldata _requests) external {
        IERC20(token).approve(address(privacyPool), amount);
        privacyPool.shield(_requests, address(0));
    }

    function shield(ShieldRequest[] calldata _requests) external {
        privacyPool.shield(_requests, address(0));
    }
}

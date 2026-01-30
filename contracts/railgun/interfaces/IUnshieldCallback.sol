// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

/**
 * @title IUnshieldCallback
 * @notice Interface for contracts that want to receive callbacks when they receive tokens from Railgun unshield
 * @dev Implement this interface to execute custom logic after receiving unshielded tokens
 *
 * POC ONLY: This is a proof-of-concept modification to demonstrate single-transaction
 * unshield-to-bridge flow. Not for production use.
 */
interface IUnshieldCallback {
    /**
     * @notice Called by RailgunLogic after transferring tokens to this contract during unshield
     * @param token The ERC20 token address that was transferred
     * @param amount The amount of tokens transferred (after fees)
     * @param originalSender The address that initiated the unshield transaction
     * @dev The implementation should handle the received tokens (e.g., bridge them via CCTP)
     */
    function onRailgunUnshield(
        address token,
        uint120 amount,
        address originalSender
    ) external;
}

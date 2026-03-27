// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../railgun/logic/Globals.sol";
import "../types/CCTPTypes.sol";

/**
 * @title IShieldModule
 * @notice Interface for the ShieldModule - handles shield operations
 * @dev Called via delegatecall from PrivacyPool router
 */
interface IShieldModule {
    /**
     * @notice Emitted when tokens are shielded into the privacy pool
     * @param treeNumber The merkle tree number
     * @param startPosition Starting leaf index
     * @param commitments The commitment preimages
     * @param shieldCiphertext Encrypted data for recipients
     * @param fees Fees charged for each shield
     */
    event Shield(
        uint256 treeNumber,
        uint256 startPosition,
        CommitmentPreimage[] commitments,
        ShieldCiphertext[] shieldCiphertext,
        uint256[] fees
    );

    /**
     * @notice Shield tokens locally (user on Hub chain)
     * @dev Transfers tokens from sender, creates commitments, inserts into merkle tree
     * @param _shieldRequests Array of shield requests to process
     * @param integrator Integrator address for fee split (address(0) for no integrator)
     */
    function shield(ShieldRequest[] calldata _shieldRequests, address integrator) external;

    /**
     * @notice Process an incoming cross-chain shield from a Client
     * @dev Called by Router when CCTP message arrives with MessageType.SHIELD
     *      USDC has already been minted to the PrivacyPool by CCTP
     *
     * @param amount Amount of USDC received (from CCTP)
     * @param data Shield data from the CCTP payload
     */
    function processIncomingShield(uint256 amount, ShieldData calldata data) external;
}

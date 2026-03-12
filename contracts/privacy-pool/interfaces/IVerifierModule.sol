// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../railgun/logic/Globals.sol";

/**
 * @title IVerifierModule
 * @notice Interface for the VerifierModule - handles SNARK proof verification
 * @dev Called via delegatecall from PrivacyPool router
 */
interface IVerifierModule {
    /**
     * @notice Set a verification key for a specific circuit configuration
     * @param _nullifiers Number of nullifiers in the circuit
     * @param _commitments Number of commitments in the circuit
     * @param _verifyingKey The verification key to set
     */
    function setVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments,
        VerifyingKey calldata _verifyingKey
    ) external;

    /**
     * @notice Get a verification key for a specific circuit configuration
     * @param _nullifiers Number of nullifiers
     * @param _commitments Number of commitments
     * @return The verification key
     */
    function getVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments
    ) external view returns (VerifyingKey memory);

    /**
     * @notice Verify a transaction's SNARK proof
     * @param _transaction The transaction to verify
     * @return True if proof is valid
     */
    function verify(Transaction calldata _transaction) external view returns (bool);

    /**
     * @notice Hash bound parameters for SNARK verification
     * @param _boundParams The bound parameters to hash
     * @return Hash of the bound parameters (mod SNARK_SCALAR_FIELD)
     */
    function hashBoundParams(BoundParams calldata _boundParams) external pure returns (uint256);
}

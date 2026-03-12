// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IVerifierModule.sol";
import "../../railgun/logic/Snark.sol";

/**
 * @title VerifierModule
 * @notice Handles SNARK proof verification for the privacy pool
 * @dev Called via delegatecall from PrivacyPool router.
 *      Based on Railgun's Verifier.sol implementation.
 *
 *      Verification keys are stored per circuit configuration (nullifiers x commitments).
 *      A testing mode (set once at initialization, immutable after) bypasses verification
 *      for development/test deployments.
 */
contract VerifierModule is PrivacyPoolStorage, IVerifierModule {
    /// @notice Emitted when a verification key is set
    event VerifyingKeySet(uint256 nullifiers, uint256 commitments, VerifyingKey verifyingKey);

    /**
     * @notice Set a verification key for a specific circuit configuration
     * @dev Only callable by owner (enforced by router)
     * @param _nullifiers Number of nullifiers in the circuit
     * @param _commitments Number of commitments in the circuit
     * @param _verifyingKey The verification key to set
     */
    function setVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments,
        VerifyingKey calldata _verifyingKey
    ) external override onlyDelegatecall {
        require(msg.sender == owner, "VerifierModule: Only owner");

        verificationKeys[_nullifiers][_commitments] = _verifyingKey;

        emit VerifyingKeySet(_nullifiers, _commitments, _verifyingKey);
    }

    /**
     * @notice Get a verification key for a specific circuit configuration
     * @param _nullifiers Number of nullifiers
     * @param _commitments Number of commitments
     * @return The verification key
     */
    function getVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments
    ) external view override returns (VerifyingKey memory) {
        return verificationKeys[_nullifiers][_commitments];
    }

    /**
     * @notice Verify a transaction's SNARK proof
     * @dev Constructs public inputs from transaction data and verifies the proof.
     *      In testing mode (set at initialization), always returns true.
     *
     * @param _transaction The transaction to verify
     * @return True if proof is valid
     */
    function verify(Transaction calldata _transaction) external view override onlyDelegatecall returns (bool) {
        // POC: Bypass verification in testing mode
        if (testingMode) {
            return true;
        }

        uint256 nullifiersLength = _transaction.nullifiers.length;
        uint256 commitmentsLength = _transaction.commitments.length;

        // Retrieve verification key for this circuit configuration
        VerifyingKey memory verifyingKey = verificationKeys[nullifiersLength][commitmentsLength];

        // Check if verifying key is set (alpha1.x == 0 means not set)
        require(verifyingKey.alpha1.x != 0, "VerifierModule: Key not set");

        // Construct public inputs array
        // Format: [merkleRoot, boundParamsHash, nullifiers..., commitments...]
        uint256[] memory inputs = new uint256[](2 + nullifiersLength + commitmentsLength);

        // Input 0: Merkle root
        inputs[0] = uint256(_transaction.merkleRoot);

        // Input 1: Hash of bound parameters
        inputs[1] = hashBoundParams(_transaction.boundParams);

        // Inputs 2 to 2+nullifiersLength-1: Nullifiers
        for (uint256 i = 0; i < nullifiersLength; i++) {
            inputs[2 + i] = uint256(_transaction.nullifiers[i]);
        }

        // Remaining inputs: Commitments
        for (uint256 i = 0; i < commitmentsLength; i++) {
            inputs[2 + nullifiersLength + i] = uint256(_transaction.commitments[i]);
        }

        // Verify the SNARK proof
        return _verifyProof(verifyingKey, _transaction.proof, inputs);
    }

    /**
     * @notice Hash bound parameters for SNARK verification
     * @param _boundParams The bound parameters to hash
     * @return Hash of the bound parameters (mod SNARK_SCALAR_FIELD)
     */
    function hashBoundParams(BoundParams calldata _boundParams) public pure override returns (uint256) {
        return uint256(keccak256(abi.encode(_boundParams))) % SNARK_SCALAR_FIELD;
    }

    /**
     * @notice Internal function to verify a SNARK proof
     * @param _verifyingKey The verification key
     * @param _proof The proof to verify
     * @param _inputs The public inputs
     * @return True if proof is valid
     */
    function _verifyProof(
        VerifyingKey memory _verifyingKey,
        SnarkProof calldata _proof,
        uint256[] memory _inputs
    ) internal view returns (bool) {
        return Snark.verify(_verifyingKey, _proof, _inputs);
    }
}

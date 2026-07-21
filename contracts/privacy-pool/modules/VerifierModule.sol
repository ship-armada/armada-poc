// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IVerifierModule.sol";

/**
 * @title VerifierModule
 * @notice Manages SNARK verification-key storage and testing mode for the privacy pool.
 * @dev Called via delegatecall from PrivacyPool router.
 *      Based on Railgun's Verifier.sol implementation.
 *
 *      Verification keys are stored per circuit configuration (nullifiers x commitments).
 *      The POC includes a testing mode that bypasses verification for development.
 *
 *      Proof verification itself is performed by `PrivacyPool.verify` (the router copy),
 *      not by this module — see the note on `verify` below.
 */
contract VerifierModule is PrivacyPoolStorage, IVerifierModule {
    /// @notice Emitted when a verification key is set
    event VerifyingKeySet(uint256 nullifiers, uint256 commitments, VerifyingKey verifyingKey);

    /// @notice Emitted when testing mode is changed
    event TestingModeSet(bool enabled);

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
     * @notice Proof verification is not performed by this module — it lives on the PrivacyPool router.
     * @dev The authoritative verifier is `PrivacyPool.verify`. During a module's own delegatecall,
     *      `address(this)` is the router, so `IVerifierModule(address(this)).verify(...)` in
     *      TransactModule dispatches to the router's copy — this module-level body is never reached
     *      because the router deliberately does not delegatecall `verify` (a view/staticcall cannot
     *      delegatecall the module and read its result, which is why the logic is inlined on the
     *      router). Keeping a second copy of the public-input construction here would risk silent
     *      drift from the authoritative implementation, so this stub reverts instead. Only
     *      verification-key writes (`setVerificationKey`/`setTestingMode`) run in this module via
     *      delegatecall; proof verification is centralized on the router.
     */
    function verify(Transaction calldata) external view override onlyDelegatecall returns (bool) {
        revert("VerifierModule: verify handled by PrivacyPool router");
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
     * @notice Enable or disable testing mode (bypasses SNARK verification)
     * @dev POC ONLY - DO NOT USE IN PRODUCTION
     * @param _enabled Whether to enable testing mode
     */
    function setTestingMode(bool _enabled) external override onlyDelegatecall {
        require(msg.sender == owner, "VerifierModule: Only owner");

        testingMode = _enabled;

        emit TestingModeSet(_enabled);
    }
}

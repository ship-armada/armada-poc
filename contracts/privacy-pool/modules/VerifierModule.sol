// SPDX-License-Identifier: MIT
// ABOUTME: SNARK verification-key registry and proof-checking module for the privacy pool.
// ABOUTME: Executes exclusively via delegatecall from the PrivacyPool router, so all state
// ABOUTME: lives in the router's storage (see PrivacyPoolStorage).
pragma solidity ^0.8.17;

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IVerifierModule.sol";
import "../types/SnarkTypes.sol";

/// @title VerifierModule
/// @notice Verification-key registry keyed by circuit shape, plus Groth16 proof checking
///         (behavior spec section 9).
/// @dev The registry maps `(nullifierCount, commitmentCount)` to a `VerifyingKey`. A key is
///      considered registered iff its `alpha1.x` coordinate is non-zero; any unregistered
///      shape reverts at verification time.
///
///      NOTE (spec OQ-2): the live verification path is the router's own `verify`
///      (`TransactModule` staticcalls the router, never this module). The `verify` below is
///      deployed but unreachable in practice; it is kept behaviorally identical to the
///      router copy — differing only in its key-not-set revert string — until the team
///      consolidates the two implementations under OQ-2.
contract VerifierModule is PrivacyPoolStorage, IVerifierModule {
    /// @notice Emitted whenever a verification key is (re)registered for a circuit shape.
    event VerifyingKeySet(uint256 nullifiers, uint256 commitments, VerifyingKey verifyingKey);

    /// @notice Emitted when the testing-mode proof bypass is toggled.
    event TestingModeSet(bool enabled);

    /// @notice Registers (or silently overwrites) the verification key for a circuit shape.
    /// @dev No structural validation is performed on the key and there is no deletion path.
    /// @param _nullifiers Nullifier count of the circuit (N).
    /// @param _commitments Commitment count of the circuit (M).
    /// @param _verifyingKey Groth16 verification key to store.
    function setVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments,
        VerifyingKey calldata _verifyingKey
    ) external override onlyDelegatecall {
        require(msg.sender == owner, "VerifierModule: Only owner");

        verificationKeys[_nullifiers][_commitments] = _verifyingKey;

        emit VerifyingKeySet(_nullifiers, _commitments, _verifyingKey);
    }

    /// @notice Returns the verification key registered for a circuit shape.
    /// @dev Unreachable through the router (the router exposes its own getter); harmless.
    /// @param _nullifiers Nullifier count of the circuit (N).
    /// @param _commitments Commitment count of the circuit (M).
    /// @return The stored key, or a zero-valued key if the shape is unregistered.
    function getVerificationKey(
        uint256 _nullifiers,
        uint256 _commitments
    ) external view override returns (VerifyingKey memory) {
        return verificationKeys[_nullifiers][_commitments];
    }

    /// @notice Checks a transaction's Groth16 proof against the key for its shape.
    /// @dev Public-input layout: `[merkleRoot, boundParamsHash, nullifiers..., commitments...]`.
    ///      The designated bypass origin short-circuits to `true` only AFTER the key-set
    ///      check and the full pairing computation have run, so gas estimation still pays
    ///      the verification cost and still reverts on unregistered shapes (spec OQ-4:
    ///      current late placement retained).
    /// @param _transaction Transaction carrying the proof and public signals.
    /// @return True iff the proof verifies (or a bypass applies).
    function verify(Transaction calldata _transaction) external view override onlyDelegatecall returns (bool) {
        // Testing mode (POC-only escape hatch, spec deviation D-3) skips verification.
        if (testingMode) {
            return true;
        }

        uint256 nullifiersLength = _transaction.nullifiers.length;
        uint256 commitmentsLength = _transaction.commitments.length;

        // Select the key by circuit shape; alpha1.x == 0 means the shape is unregistered.
        VerifyingKey memory verifyingKey = verificationKeys[nullifiersLength][commitmentsLength];
        require(verifyingKey.alpha1.x != 0, "VerifierModule: Key not set");

        // Assemble the public-input vector (spec section 2.3).
        uint256[] memory inputs = new uint256[](2 + nullifiersLength + commitmentsLength);
        inputs[0] = uint256(_transaction.merkleRoot);
        inputs[1] = hashBoundParams(_transaction.boundParams);
        for (uint256 i = 0; i < nullifiersLength; i++) {
            inputs[2 + i] = uint256(_transaction.nullifiers[i]);
        }
        for (uint256 i = 0; i < commitmentsLength; i++) {
            inputs[2 + nullifiersLength + i] = uint256(_transaction.commitments[i]);
        }

        bool validity = Snark.verify(verifyingKey, _transaction.proof, inputs);

        // Gas-estimation escape hatch: checked last, on purpose (spec OQ-4).
        // solhint-disable-next-line avoid-tx-origin
        if (tx.origin == VERIFICATION_BYPASS) {
            return true;
        }

        return validity;
    }

    /// @notice Hashes the bound parameters into a SNARK scalar field element.
    /// @param _boundParams Bound parameters of the transaction.
    /// @return `keccak256` of the standard ABI encoding, reduced mod the scalar field.
    function hashBoundParams(BoundParams calldata _boundParams) public pure override returns (uint256) {
        return uint256(keccak256(abi.encode(_boundParams))) % SNARK_SCALAR_FIELD;
    }

    /// @notice Toggles the testing-mode proof bypass.
    /// @dev POC ONLY — MUST NOT ship to production (spec deviation D-3 / OQ-11).
    /// @param _enabled Whether testing mode is enabled.
    function setTestingMode(bool _enabled) external override onlyDelegatecall {
        require(msg.sender == owner, "VerifierModule: Only owner");

        testingMode = _enabled;

        emit TestingModeSet(_enabled);
    }
}

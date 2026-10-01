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

    /// @notice Proof verification does not run in this module — it lives on the router.
    /// @dev The authoritative verifier is `PrivacyPool.verify`. Modules reach verification via
    ///      `IVerifierModule(address(this)).verify(...)` during their delegatecall, which dispatches
    ///      to the router's copy; this module-level body is never reached because a view/staticcall
    ///      cannot delegatecall the module and read the result (which is why the logic is inlined on
    ///      the router). Keeping a second public-input construction here would risk silent drift from
    ///      the authoritative implementation, so this stub reverts instead. Only verification-key
    ///      writes run in this module via delegatecall.
    /// @return Never returns — always reverts.
    function verify(Transaction calldata) external view override onlyDelegatecall returns (bool) {
        revert("VerifierModule: verify handled by PrivacyPool router");
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

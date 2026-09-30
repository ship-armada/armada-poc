// SPDX-License-Identifier: MIT
// ABOUTME: Interface stubs for the two Poseidon hash arities used by the privacy pool.
// ABOUTME: Deployments link externally deployed circomlib-compatible bytecode at these
// ABOUTME: library addresses; the stub bodies exist only so the source tree compiles.
pragma solidity ^0.8.17;

/// @title PoseidonT3
/// @notice Two-input Poseidon hash over the BN254 scalar field (state width t = 3).
/// @dev Used for Merkle node hashing and other two-field digests. The function is
///      external to the library bytecode: at deploy time this library is linked against
///      a separately deployed Poseidon implementation, so the body below never runs in
///      a correctly linked deployment.
library PoseidonT3 {
    function poseidon(bytes32[2] memory input) public pure returns (bytes32) {
        (input);
        revert("PoseidonT3: library not linked");
    }
}

/// @title PoseidonT4
/// @notice Three-input Poseidon hash over the BN254 scalar field (state width t = 4).
/// @dev Used for commitment hashing. Linking requirement identical to PoseidonT3.
library PoseidonT4 {
    function poseidon(bytes32[3] memory input) public pure returns (bytes32) {
        (input);
        revert("PoseidonT4: library not linked");
    }
}

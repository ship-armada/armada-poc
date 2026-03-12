// ABOUTME: Encoding/verification library for yield adapter bound parameters.
// ABOUTME: Binds re-shield destination in ZK proofs, with separate hashes for lend vs redeem operations.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../railgun/logic/Globals.sol";

/**
 * @title YieldAdaptParams
 * @notice Encoding/decoding for yield adapter bound parameters
 * @dev The adaptParams field in a transaction binds the re-shield destination.
 *      This ensures the adapter cannot shield to a different recipient than
 *      what the user committed to in their SNARK proof.
 *
 *      Two hash schemes are used:
 *      - Lend (encode/verify): binds npk + ciphertext for the lend operation
 *      - Redeem (encodeRedeem/verifyRedeem): binds npk + ciphertext + depositNonce
 *        so the adapter must use the correct per-deposit cost basis
 *
 *      Trust Model:
 *      - User generates proof with adaptParams = hash(npk, encryptedBundle, shieldKey[, nonce])
 *      - Adapter verifies the provided shield parameters match adaptParams
 *      - If they don't match -> revert
 *      - This makes the adapter trustless: it MUST use the user's committed parameters
 */
library YieldAdaptParams {
    /**
     * @notice Encode lend operation parameters into adaptParams
     * @dev Called by frontend when generating the unshield proof for lendAndShield.
     *      The resulting hash is set as boundParams.adaptParams in the transaction.
     *
     * @param npk Note public key for re-shielding (user's receiving key)
     * @param encryptedBundle Shield ciphertext bundle [3]
     * @param shieldKey Public key used to generate shared encryption key
     * @return adaptParams Keccak256 hash of all parameters
     */
    function encode(
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(npk, encryptedBundle, shieldKey));
    }

    /**
     * @notice Verify that lend shield request matches the bound adaptParams
     * @dev Called by adapter before executing lendAndShield. If this fails,
     *      the adapter cannot proceed - ensuring trustless execution.
     *
     * @param adaptParams The bound parameters from the user's transaction proof
     * @param npk Note public key from shield request
     * @param encryptedBundle Shield ciphertext from shield request
     * @param shieldKey Shield public key from shield request
     * @return True if parameters match the commitment
     */
    function verify(
        bytes32 adaptParams,
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey
    ) internal pure returns (bool) {
        return adaptParams == encode(npk, encryptedBundle, shieldKey);
    }

    /**
     * @notice Encode redeem operation parameters into adaptParams
     * @dev Called by frontend when generating the unshield proof for redeemAndShield.
     *      Includes the depositNonce to bind the redeem to a specific deposit's cost basis.
     *
     * @param npk Note public key for re-shielding (user's receiving key)
     * @param encryptedBundle Shield ciphertext bundle [3]
     * @param shieldKey Public key used to generate shared encryption key
     * @param depositNonce The deposit nonce from the original lendAndShield operation
     * @return adaptParams Keccak256 hash of all parameters including nonce
     */
    function encodeRedeem(
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey,
        uint256 depositNonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(npk, encryptedBundle, shieldKey, depositNonce));
    }

    /**
     * @notice Verify that redeem shield request matches the bound adaptParams
     * @dev Called by adapter before executing redeemAndShield. Verifies the
     *      depositNonce is included in the commitment, preventing the adapter
     *      from substituting a different deposit's cost basis.
     *
     * @param adaptParams The bound parameters from the user's transaction proof
     * @param npk Note public key from shield request
     * @param encryptedBundle Shield ciphertext from shield request
     * @param shieldKey Shield public key from shield request
     * @param depositNonce The deposit nonce to verify
     * @return True if parameters match the commitment
     */
    function verifyRedeem(
        bytes32 adaptParams,
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey,
        uint256 depositNonce
    ) internal pure returns (bool) {
        return adaptParams == encodeRedeem(npk, encryptedBundle, shieldKey, depositNonce);
    }
}

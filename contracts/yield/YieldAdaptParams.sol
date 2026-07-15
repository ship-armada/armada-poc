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
 *      Trust Model:
 *      - User generates proof with adaptParams = hash(npk, encryptedBundle, shieldKey, feeRecipient, feeAmount)
 *      - Adapter verifies the provided shield parameters AND broadcaster fee match adaptParams
 *      - If they don't match → revert
 *      - This makes the adapter trustless: it MUST use the user's committed parameters, and a
 *        relayer cannot redirect the fee or inflate its amount beyond what the user committed to.
 */
library YieldAdaptParams {
    /**
     * @notice Encode shield-destination-only parameters (lend / deposit path — no adapter-side fee).
     * @dev Called by frontend when generating the deposit unshield proof.
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
     * @notice Encode shield destination + broadcaster fee (redeem / withdraw path).
     * @dev The fee is bound into adaptParams so a relayer cannot redirect it or inflate the amount.
     *      Produces a DIFFERENT commitment than the 3-arg overload — the two paths are distinct.
     *
     * @param npk Note public key for re-shielding (user's receiving key)
     * @param encryptedBundle Shield ciphertext bundle [3]
     * @param shieldKey Public key used to generate shared encryption key
     * @param feeRecipient Broadcaster (relayer) fee recipient, paid from proceeds (address(0) if no fee)
     * @param feeAmount Broadcaster fee amount in the proceeds token's raw units (0 if no fee)
     * @return adaptParams Keccak256 hash of all parameters
     */
    function encode(
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey,
        address feeRecipient,
        uint256 feeAmount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(npk, encryptedBundle, shieldKey, feeRecipient, feeAmount));
    }

    /**
     * @notice Verify a shield request matches the bound adaptParams (lend / deposit path).
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
     * @notice Verify a shield request + broadcaster fee match the bound adaptParams (redeem / withdraw path).
     * @dev If this fails the adapter cannot proceed — ensuring trustless execution and a
     *      relayer-immutable fee.
     *
     * @param adaptParams The bound parameters from the user's transaction proof
     * @param npk Note public key from shield request
     * @param encryptedBundle Shield ciphertext from shield request
     * @param shieldKey Shield public key from shield request
     * @param feeRecipient Broadcaster fee recipient supplied to the adapter
     * @param feeAmount Broadcaster fee amount supplied to the adapter
     * @return True if parameters match the commitment
     */
    function verify(
        bytes32 adaptParams,
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey,
        address feeRecipient,
        uint256 feeAmount
    ) internal pure returns (bool) {
        return adaptParams == encode(npk, encryptedBundle, shieldKey, feeRecipient, feeAmount);
    }
}

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
     * @notice Encode the user's shield destination + the broadcaster fee, where the fee is itself paid
     *         as a SHIELD to the relayer's own 0zk destination (redeem / withdraw path).
     * @dev Binding both shield destinations + the amount makes the fee relayer-immutable: the submitter
     *      cannot redirect the fee to a different note or inflate its amount. Produces a DIFFERENT
     *      commitment than the 3-arg overload — the two paths are distinct.
     *
     * @param npk Note public key for the user's re-shield (user's receiving key)
     * @param encryptedBundle User's shield ciphertext bundle [3]
     * @param shieldKey User's shield public key
     * @param feeNpk Note public key for the relayer's fee shield (relayer's 0zk receiving key; 0 if no fee)
     * @param feeEncryptedBundle Relayer's shield ciphertext bundle [3] (zeroed if no fee)
     * @param feeShieldKey Relayer's shield public key (0 if no fee)
     * @param feeAmount Broadcaster fee amount in the proceeds token's raw units (0 if no fee)
     * @return adaptParams Keccak256 hash of all parameters
     */
    function encode(
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey,
        bytes32 feeNpk,
        bytes32[3] memory feeEncryptedBundle,
        bytes32 feeShieldKey,
        uint256 feeAmount
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(npk, encryptedBundle, shieldKey, feeNpk, feeEncryptedBundle, feeShieldKey, feeAmount)
        );
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
     * @notice Verify the user's shield request + the relayer fee-shield destination match the bound
     *         adaptParams (redeem / withdraw path).
     * @dev If this fails the adapter cannot proceed — ensuring trustless execution and a
     *      relayer-immutable fee paid to the relayer's own 0zk address.
     *
     * @param adaptParams The bound parameters from the user's transaction proof
     * @param npk User's re-shield note public key
     * @param encryptedBundle User's shield ciphertext
     * @param shieldKey User's shield public key
     * @param feeNpk Relayer's fee-shield note public key
     * @param feeEncryptedBundle Relayer's fee-shield ciphertext
     * @param feeShieldKey Relayer's fee-shield public key
     * @param feeAmount Broadcaster fee amount supplied to the adapter
     * @return True if parameters match the commitment
     */
    function verify(
        bytes32 adaptParams,
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey,
        bytes32 feeNpk,
        bytes32[3] memory feeEncryptedBundle,
        bytes32 feeShieldKey,
        uint256 feeAmount
    ) internal pure returns (bool) {
        return adaptParams
            == encode(npk, encryptedBundle, shieldKey, feeNpk, feeEncryptedBundle, feeShieldKey, feeAmount);
    }
}

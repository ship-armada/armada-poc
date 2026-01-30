// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title CCTPTypes
 * @notice Message types and payload structures for CCTP cross-chain communication
 * @dev Used by PrivacyPool (Hub) and PrivacyPoolClient (Client) for encoding/decoding
 *      CCTP hook data in cross-chain shield and unshield operations.
 */

/**
 * @notice Message types for CCTP payloads
 * @dev SHIELD: Client -> Hub (cross-chain shield request)
 *      UNSHIELD: Hub -> Client (atomic cross-chain unshield)
 */
enum MessageType {
    SHIELD,
    UNSHIELD
}

/**
 * @notice Wrapper for all CCTP hook payloads
 * @param messageType The type of message (SHIELD or UNSHIELD)
 * @param data ABI-encoded type-specific data (ShieldData or UnshieldData)
 */
struct CCTPPayload {
    MessageType messageType;
    bytes data;
}

/**
 * @notice Shield request data sent from Client to Hub via CCTP
 * @dev Hub uses this to construct a ShieldRequest and insert into merkle tree
 *      Token information is not included - Hub uses its local USDC address
 *
 * @param npk Note public key - Poseidon hash representing note ownership
 * @param value Amount being shielded (must match CCTP transfer amount)
 * @param encryptedBundle Shield ciphertext encrypted bundle [3 x bytes32]
 * @param shieldKey Public key for shared secret derivation
 */
struct ShieldData {
    bytes32 npk;
    uint120 value;
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
}

/**
 * @notice Unshield data sent from Hub to Client via CCTP
 * @dev Minimal payload - Hub already validated proof and nullified inputs
 *      Client just needs to know where to forward the USDC
 *
 * @param recipient Address to receive USDC on client chain
 */
struct UnshieldData {
    address recipient;
}

/**
 * @title CCTPPayloadLib
 * @notice Library for encoding and decoding CCTP payloads
 */
library CCTPPayloadLib {
    /**
     * @notice Encode a shield payload for CCTP hook data
     */
    function encodeShield(ShieldData memory data) internal pure returns (bytes memory) {
        return abi.encode(CCTPPayload({
            messageType: MessageType.SHIELD,
            data: abi.encode(data)
        }));
    }

    /**
     * @notice Encode an unshield payload for CCTP hook data
     */
    function encodeUnshield(UnshieldData memory data) internal pure returns (bytes memory) {
        return abi.encode(CCTPPayload({
            messageType: MessageType.UNSHIELD,
            data: abi.encode(data)
        }));
    }

    /**
     * @notice Decode CCTP hook data into a CCTPPayload
     */
    function decode(bytes memory hookData) internal pure returns (CCTPPayload memory) {
        return abi.decode(hookData, (CCTPPayload));
    }

    /**
     * @notice Decode shield data from CCTPPayload.data
     */
    function decodeShieldData(bytes memory data) internal pure returns (ShieldData memory) {
        return abi.decode(data, (ShieldData));
    }

    /**
     * @notice Decode unshield data from CCTPPayload.data
     */
    function decodeUnshieldData(bytes memory data) internal pure returns (UnshieldData memory) {
        return abi.decode(data, (UnshieldData));
    }
}

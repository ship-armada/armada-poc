// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title CCTP V2 Interfaces and Message Libraries
 * @notice Interfaces and encoding matching Circle's CCTP V2 contracts for testnet compatibility
 * @dev These interfaces allow our contracts to work with both:
 *      - Local mock CCTP (for development/testing)
 *      - Real Circle CCTP V2 (for public testnets/mainnet)
 *
 * Reference: https://developers.circle.com/cctp/evm-smart-contracts
 * Contract addresses (Ethereum mainnet):
 *   - TokenMessengerV2: 0x28b5a0e9c621a5badaa536219b3a228c8168cf5d
 *   - MessageTransmitterV2: 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
 *
 * Sepolia testnet:
 *   - TokenMessengerV2: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
 *   - MessageTransmitterV2: 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
 */

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * @title ITokenMessengerV2
 * @notice Interface for Circle's TokenMessengerV2 contract
 * @dev Used by PrivacyPoolClient and TransactModule to initiate burns
 */
interface ITokenMessengerV2 {
    /**
     * @notice Deposits and burns tokens to be minted on destination domain
     * @param amount Amount of tokens to burn
     * @param destinationDomain Circle domain ID of destination chain
     * @param mintRecipient Address to receive minted tokens (as bytes32)
     * @param burnToken Address of token to burn
     * @param destinationCaller Address allowed to call receiveMessage (bytes32), or 0 for any
     * @param maxFee Maximum fee willing to pay for fast finality
     * @param minFinalityThreshold Minimum finality level (1000=fast, 2000=standard)
     * @return nonce Unique identifier for this burn
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce);

    /**
     * @notice Deposits and burns tokens with hook data for destination chain execution
     * @param amount Amount of tokens to burn
     * @param destinationDomain Circle domain ID of destination chain
     * @param mintRecipient Address to receive minted tokens (as bytes32)
     * @param burnToken Address of token to burn
     * @param destinationCaller Address allowed to call receiveMessage (bytes32), or 0 for any
     * @param maxFee Maximum fee willing to pay for fast finality
     * @param minFinalityThreshold Minimum finality level (1000=fast, 2000=standard)
     * @param hookData Arbitrary data passed to destination for custom logic
     * @return nonce Unique identifier for this burn
     */
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external returns (uint64 nonce);
}

/**
 * @title IMessageTransmitterV2
 * @notice Interface for Circle's MessageTransmitterV2 contract
 * @dev Used by relayers to deliver messages on destination chain
 */
interface IMessageTransmitterV2 {
    /**
     * @notice Receives a message with attestation and executes it
     * @param message The original message bytes (MessageV2 format)
     * @param attestation Circle attestation signature(s), or empty for mock
     * @return success Whether the message was successfully processed
     */
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success);

    /**
     * @notice Get the local domain ID for this chain
     * @return domain The Circle domain ID
     */
    function localDomain() external view returns (uint32 domain);
}

/**
 * @title IMessageHandlerV2
 * @notice Interface that recipients must implement to receive CCTP V2 messages with hooks
 * @dev PrivacyPool and PrivacyPoolClient implement this to receive cross-chain messages
 */
interface IMessageHandlerV2 {
    /**
     * @notice Handle a finalized cross-chain message (finalityThresholdExecuted >= 2000)
     * @param remoteDomain Source domain ID
     * @param sender Sender address on source domain (as bytes32)
     * @param finalityThresholdExecuted The finality threshold that was met
     * @param messageBody The BurnMessageV2 content
     * @return success Whether the message was handled successfully
     */
    function handleReceiveFinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool success);

    /**
     * @notice Handle an unfinalized (fast) cross-chain message (finalityThresholdExecuted < 2000)
     * @param remoteDomain Source domain ID
     * @param sender Sender address on source domain (as bytes32)
     * @param finalityThresholdExecuted The finality threshold that was met
     * @param messageBody The BurnMessageV2 content
     * @return success Whether the message was handled successfully
     */
    function handleReceiveUnfinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool success);
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * @title Circle Domain IDs
 * @notice Constants for Circle CCTP domain identifiers
 * @dev These are NOT EVM chain IDs - they are Circle-specific domain IDs
 *
 * Mainnet domains:
 *   Ethereum: 0
 *   Avalanche: 1
 *   Optimism: 2
 *   Arbitrum: 3
 *   Base: 6
 *   Polygon PoS: 7
 *
 * Testnet domains (Sepolia, etc.) use the same domain IDs as mainnet
 */
library CCTPDomains {
    uint32 constant ETHEREUM = 0;
    uint32 constant AVALANCHE = 1;
    uint32 constant OPTIMISM = 2;
    uint32 constant ARBITRUM = 3;
    uint32 constant BASE = 6;
    uint32 constant POLYGON = 7;

    // For local testing, we use high domain IDs to avoid conflicts
    uint32 constant LOCAL_HUB = 100;
    uint32 constant LOCAL_CLIENT_A = 101;
    uint32 constant LOCAL_CLIENT_B = 102;
}

/**
 * @title CCTP V2 Finality Thresholds
 * @notice Constants for finality levels in CCTP V2
 */
library CCTPFinality {
    // Fast finality - attested at "confirmed" level, faster but costs a fee
    uint32 constant FAST = 1000;

    // Standard finality - attested at "finalized" level, slower but more secure
    uint32 constant STANDARD = 2000;
}

// ============================================================================
// MESSAGE LIBRARIES
// ============================================================================

/**
 * @title MessageV2
 * @notice Library for encoding/decoding CCTP V2 message envelope
 * @dev This is the outer message format used by MessageTransmitter.receiveMessage()
 *
 * Real CCTP V2 Message format:
 * | Field                     | Bytes | Offset |
 * |---------------------------|-------|--------|
 * | version                   | 4     | 0      |
 * | sourceDomain              | 4     | 4      |
 * | destinationDomain         | 4     | 8      |
 * | nonce                     | 8     | 12     |
 * | sender                    | 32    | 20     |
 * | recipient                 | 32    | 52     |
 * | destinationCaller         | 32    | 84     |
 * | minFinalityThreshold      | 4     | 116    |
 * | finalityThresholdExecuted | 4     | 120    |
 * | messageBody               | var   | 124    |
 */
library MessageV2 {
    // Byte offsets for message fields
    uint256 constant VERSION_OFFSET = 0;
    uint256 constant SOURCE_DOMAIN_OFFSET = 4;
    uint256 constant DESTINATION_DOMAIN_OFFSET = 8;
    uint256 constant NONCE_OFFSET = 12;
    uint256 constant SENDER_OFFSET = 20;
    uint256 constant RECIPIENT_OFFSET = 52;
    uint256 constant DESTINATION_CALLER_OFFSET = 84;
    uint256 constant MIN_FINALITY_THRESHOLD_OFFSET = 116;
    uint256 constant FINALITY_THRESHOLD_EXECUTED_OFFSET = 120;
    uint256 constant MESSAGE_BODY_OFFSET = 124;

    // Minimum message length (header only, no body)
    uint256 constant MIN_MESSAGE_LENGTH = 124;

    // Current message version
    uint32 constant MESSAGE_VERSION = 1;

    /**
     * @notice Encode a full CCTP V2 message
     */
    function encode(
        uint32 sourceDomain,
        uint32 destinationDomain,
        uint64 nonce,
        bytes32 sender,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        uint32 finalityThresholdExecuted,
        bytes memory messageBody
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            MESSAGE_VERSION,
            sourceDomain,
            destinationDomain,
            nonce,
            sender,
            recipient,
            destinationCaller,
            minFinalityThreshold,
            finalityThresholdExecuted,
            messageBody
        );
    }

    /**
     * @notice Decode a full CCTP V2 message
     */
    function decode(bytes calldata message) internal pure returns (
        uint32 version,
        uint32 sourceDomain,
        uint32 destinationDomain,
        uint64 nonce,
        bytes32 sender,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");

        version = uint32(bytes4(message[VERSION_OFFSET:VERSION_OFFSET + 4]));
        sourceDomain = uint32(bytes4(message[SOURCE_DOMAIN_OFFSET:SOURCE_DOMAIN_OFFSET + 4]));
        destinationDomain = uint32(bytes4(message[DESTINATION_DOMAIN_OFFSET:DESTINATION_DOMAIN_OFFSET + 4]));
        nonce = uint64(bytes8(message[NONCE_OFFSET:NONCE_OFFSET + 8]));
        sender = bytes32(message[SENDER_OFFSET:SENDER_OFFSET + 32]);
        recipient = bytes32(message[RECIPIENT_OFFSET:RECIPIENT_OFFSET + 32]);
        destinationCaller = bytes32(message[DESTINATION_CALLER_OFFSET:DESTINATION_CALLER_OFFSET + 32]);
        minFinalityThreshold = uint32(bytes4(message[MIN_FINALITY_THRESHOLD_OFFSET:MIN_FINALITY_THRESHOLD_OFFSET + 4]));
        finalityThresholdExecuted = uint32(bytes4(message[FINALITY_THRESHOLD_EXECUTED_OFFSET:FINALITY_THRESHOLD_EXECUTED_OFFSET + 4]));
        messageBody = message[MESSAGE_BODY_OFFSET:];
    }

    /**
     * @notice Convert an address to bytes32 (left-padded with zeros)
     * @dev Matches Circle's Message.sol addressToBytes32
     */
    function addressToBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    /**
     * @notice Convert bytes32 to an address (takes lower 20 bytes)
     * @dev Matches Circle's Message.sol bytes32ToAddress
     */
    function bytes32ToAddress(bytes32 buf) internal pure returns (address) {
        return address(uint160(uint256(buf)));
    }

    // ========== Individual Field Getters (to avoid stack-too-deep) ==========

    function getVersion(bytes calldata message) internal pure returns (uint32) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return uint32(bytes4(message[VERSION_OFFSET:VERSION_OFFSET + 4]));
    }

    function getSourceDomain(bytes calldata message) internal pure returns (uint32) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return uint32(bytes4(message[SOURCE_DOMAIN_OFFSET:SOURCE_DOMAIN_OFFSET + 4]));
    }

    function getDestinationDomain(bytes calldata message) internal pure returns (uint32) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return uint32(bytes4(message[DESTINATION_DOMAIN_OFFSET:DESTINATION_DOMAIN_OFFSET + 4]));
    }

    function getNonce(bytes calldata message) internal pure returns (uint64) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return uint64(bytes8(message[NONCE_OFFSET:NONCE_OFFSET + 8]));
    }

    function getSender(bytes calldata message) internal pure returns (bytes32) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return bytes32(message[SENDER_OFFSET:SENDER_OFFSET + 32]);
    }

    function getDestinationCaller(bytes calldata message) internal pure returns (bytes32) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return bytes32(message[DESTINATION_CALLER_OFFSET:DESTINATION_CALLER_OFFSET + 32]);
    }

    function getFinalityThresholdExecuted(bytes calldata message) internal pure returns (uint32) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return uint32(bytes4(message[FINALITY_THRESHOLD_EXECUTED_OFFSET:FINALITY_THRESHOLD_EXECUTED_OFFSET + 4]));
    }

    function getMessageBody(bytes calldata message) internal pure returns (bytes calldata) {
        require(message.length >= MIN_MESSAGE_LENGTH, "MessageV2: message too short");
        return message[MESSAGE_BODY_OFFSET:];
    }
}

/**
 * @title BurnMessageV2
 * @notice Library for encoding/decoding CCTP V2 burn messages (messageBody content)
 * @dev This is the inner message format for token transfers, embedded in MessageV2.messageBody
 *
 * Real CCTP V2 BurnMessage format:
 * | Field           | Bytes | Offset |
 * |-----------------|-------|--------|
 * | version         | 4     | 0      |
 * | burnToken       | 32    | 4      |
 * | mintRecipient   | 32    | 36     |
 * | amount          | 32    | 68     |
 * | messageSender   | 32    | 100    |
 * | maxFee          | 32    | 132    |
 * | feeExecuted     | 32    | 164    |
 * | expirationBlock | 32    | 196    |
 * | hookData        | var   | 228    |
 */
library BurnMessageV2 {
    // Byte offsets for burn message fields
    uint256 constant VERSION_OFFSET = 0;
    uint256 constant BURN_TOKEN_OFFSET = 4;
    uint256 constant MINT_RECIPIENT_OFFSET = 36;
    uint256 constant AMOUNT_OFFSET = 68;
    uint256 constant MESSAGE_SENDER_OFFSET = 100;
    uint256 constant MAX_FEE_OFFSET = 132;
    uint256 constant FEE_EXECUTED_OFFSET = 164;
    uint256 constant EXPIRATION_BLOCK_OFFSET = 196;
    uint256 constant HOOK_DATA_OFFSET = 228;

    // Minimum burn message length (without hookData)
    uint256 constant MIN_BURN_MESSAGE_LENGTH = 228;

    // Current burn message version
    uint32 constant BURN_MESSAGE_VERSION = 1;

    /**
     * @notice Encode a full CCTP V2 burn message
     */
    function encode(
        bytes32 burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        bytes32 messageSender,
        uint256 maxFee,
        uint256 feeExecuted,
        uint256 expirationBlock,
        bytes memory hookData
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            BURN_MESSAGE_VERSION,
            burnToken,
            mintRecipient,
            amount,
            messageSender,
            maxFee,
            feeExecuted,
            expirationBlock,
            hookData
        );
    }

    /**
     * @notice Decode a full CCTP V2 burn message
     */
    function decode(bytes calldata messageBody) internal pure returns (
        uint32 version,
        bytes32 burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        bytes32 messageSender,
        uint256 maxFee,
        uint256 feeExecuted,
        uint256 expirationBlock,
        bytes memory hookData
    ) {
        require(messageBody.length >= MIN_BURN_MESSAGE_LENGTH, "BurnMessageV2: message too short");

        version = uint32(bytes4(messageBody[VERSION_OFFSET:VERSION_OFFSET + 4]));
        burnToken = bytes32(messageBody[BURN_TOKEN_OFFSET:BURN_TOKEN_OFFSET + 32]);
        mintRecipient = bytes32(messageBody[MINT_RECIPIENT_OFFSET:MINT_RECIPIENT_OFFSET + 32]);
        amount = uint256(bytes32(messageBody[AMOUNT_OFFSET:AMOUNT_OFFSET + 32]));
        messageSender = bytes32(messageBody[MESSAGE_SENDER_OFFSET:MESSAGE_SENDER_OFFSET + 32]);
        maxFee = uint256(bytes32(messageBody[MAX_FEE_OFFSET:MAX_FEE_OFFSET + 32]));
        feeExecuted = uint256(bytes32(messageBody[FEE_EXECUTED_OFFSET:FEE_EXECUTED_OFFSET + 32]));
        expirationBlock = uint256(bytes32(messageBody[EXPIRATION_BLOCK_OFFSET:EXPIRATION_BLOCK_OFFSET + 32]));

        if (messageBody.length > HOOK_DATA_OFFSET) {
            hookData = messageBody[HOOK_DATA_OFFSET:];
        } else {
            hookData = "";
        }
    }

    /**
     * @notice Convenience function to decode only the fields needed for hook processing
     * @dev Use this in handleReceiveFinalizedMessage to avoid decoding unused fields
     * @return amount The gross amount (before fee deduction)
     * @return feeExecuted The fee that was deducted (actualMint = amount - feeExecuted)
     * @return hookData The hook data for custom processing
     */
    function decodeForHook(bytes calldata messageBody) internal pure returns (
        uint256 amount,
        uint256 feeExecuted,
        bytes memory hookData
    ) {
        require(messageBody.length >= MIN_BURN_MESSAGE_LENGTH, "BurnMessageV2: message too short");

        amount = uint256(bytes32(messageBody[AMOUNT_OFFSET:AMOUNT_OFFSET + 32]));
        feeExecuted = uint256(bytes32(messageBody[FEE_EXECUTED_OFFSET:FEE_EXECUTED_OFFSET + 32]));

        if (messageBody.length > HOOK_DATA_OFFSET) {
            hookData = messageBody[HOOK_DATA_OFFSET:];
        } else {
            hookData = "";
        }
    }

    /**
     * @notice Get the mint recipient from a burn message
     */
    function getMintRecipient(bytes calldata messageBody) internal pure returns (bytes32) {
        require(messageBody.length >= MIN_BURN_MESSAGE_LENGTH, "BurnMessageV2: message too short");
        return bytes32(messageBody[MINT_RECIPIENT_OFFSET:MINT_RECIPIENT_OFFSET + 32]);
    }

    /**
     * @notice Get the burn token from a burn message
     */
    function getBurnToken(bytes calldata messageBody) internal pure returns (bytes32) {
        require(messageBody.length >= MIN_BURN_MESSAGE_LENGTH, "BurnMessageV2: message too short");
        return bytes32(messageBody[BURN_TOKEN_OFFSET:BURN_TOKEN_OFFSET + 32]);
    }
}

// ============================================================================
// LEGACY COMPATIBILITY (for gradual migration)
// ============================================================================

/**
 * @title BurnMessage (Legacy)
 * @notice DEPRECATED - Use BurnMessageV2 instead
 * @dev Kept for backward compatibility during migration. Will be removed.
 */
library BurnMessage {
    function decode(bytes calldata messageBody)
        internal
        pure
        returns (
            address burnToken,
            bytes32 mintRecipient,
            uint256 amount,
            bytes memory hookData
        )
    {
        // Decode using new format
        (
            ,  // version
            bytes32 burnTokenBytes,
            bytes32 mintRecipientBytes,
            uint256 amountDecoded,
            ,  // messageSender
            ,  // maxFee
            ,  // feeExecuted
            ,  // expirationBlock
            bytes memory hookDataDecoded
        ) = BurnMessageV2.decode(messageBody);

        burnToken = MessageV2.bytes32ToAddress(burnTokenBytes);
        mintRecipient = mintRecipientBytes;
        amount = amountDecoded;
        hookData = hookDataDecoded;
    }

    function encode(
        address burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        bytes memory hookData
    ) internal pure returns (bytes memory) {
        // Encode using new format with default values for new fields
        return BurnMessageV2.encode(
            MessageV2.addressToBytes32(burnToken),
            mintRecipient,
            amount,
            bytes32(0),  // messageSender - filled by TokenMessenger
            0,           // maxFee
            0,           // feeExecuted
            0,           // expirationBlock
            hookData
        );
    }
}

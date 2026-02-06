// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ICCTPV2.sol";

/**
 * @title MockTokenMessengerV2
 * @notice Simulates Circle's TokenMessengerV2 for local testing
 * @dev Mimics the real CCTP V2 interface so contracts can deploy unchanged to testnets
 *
 * Architecture matches real CCTP:
 *   TokenMessengerV2 (this) - handles burn/mint token logic
 *   MessageTransmitterV2    - handles message passing and attestation
 *   USDC                    - standard ERC20 (we use MockUSDC for testing)
 *
 * On real CCTP, TokenMessenger calls MessageTransmitter.sendMessage()
 * Here we emit events that our relayer picks up to simulate the flow.
 */
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    using SafeERC20 for IERC20;

    // The message transmitter that handles cross-chain messaging
    address public immutable messageTransmitter;

    // The token we're bridging (USDC)
    address public immutable usdc;

    // Local domain ID (Circle domain, not chain ID)
    uint32 public immutable localDomain;

    // Burn nonce counter
    uint64 public nextNonce;

    // Remote TokenMessenger addresses per domain (for validation)
    mapping(uint32 => bytes32) public remoteTokenMessengers;

    // Note: We don't emit DepositForBurn/DepositForBurnWithHook events to avoid stack too deep.
    // The MessageSent event from MessageTransmitter contains all necessary info for relaying.

    constructor(
        address _messageTransmitter,
        address _usdc,
        uint32 _localDomain
    ) {
        messageTransmitter = _messageTransmitter;
        usdc = _usdc;
        localDomain = _localDomain;
    }

    /**
     * @notice Register a remote TokenMessenger for a domain
     * @dev In real CCTP, this is managed by Circle. Here we allow config for testing.
     */
    function setRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external {
        remoteTokenMessengers[domain] = tokenMessenger;
    }

    /**
     * @inheritdoc ITokenMessengerV2
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce) {
        require(burnToken == usdc, "Unsupported token");
        require(amount > 0, "Amount must be > 0");
        require(mintRecipient != bytes32(0), "Invalid recipient");

        // Transfer and burn tokens
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        IMockBurnable(usdc).burn(amount);

        // Get nonce
        nonce = nextNonce++;

        // Send message to transmitter (emits MessageSent event)
        _sendBurnMessage(
            destinationDomain,
            destinationCaller,
            nonce,
            burnToken,
            mintRecipient,
            amount,
            maxFee,
            minFinalityThreshold,
            "" // No hook data
        );

        return nonce;
    }

    /**
     * @inheritdoc ITokenMessengerV2
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
    ) external returns (uint64 nonce) {
        require(burnToken == usdc, "Unsupported token");
        require(amount > 0, "Amount must be > 0");
        require(mintRecipient != bytes32(0), "Invalid recipient");
        require(hookData.length > 0, "Hook data required");

        // Transfer and burn tokens
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        IMockBurnable(usdc).burn(amount);

        // Get nonce
        nonce = nextNonce++;

        // Send message to transmitter using struct to avoid stack issues
        _sendBurnMessage(
            destinationDomain,
            destinationCaller,
            nonce,
            burnToken,
            mintRecipient,
            amount,
            maxFee,
            minFinalityThreshold,
            hookData
        );

        return nonce;
    }

    /**
     * @dev Internal function to send burn message, avoiding stack too deep
     */
    function _sendBurnMessage(
        uint32 destinationDomain,
        bytes32 destinationCaller,
        uint64 nonce,
        address burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes memory hookData
    ) internal {
        MockMessageTransmitterV2(messageTransmitter).sendMessageForBurn(
            destinationDomain,
            remoteTokenMessengers[destinationDomain],
            destinationCaller,
            nonce,
            burnToken,
            mintRecipient,
            amount,
            MessageV2.addressToBytes32(msg.sender), // messageSender
            maxFee,
            minFinalityThreshold,
            hookData
        );
    }

    /**
     * @notice Handle incoming message from MessageTransmitter (mint tokens)
     * @dev Called by MessageTransmitter when a valid message is received
     * @param sourceDomain The source chain's CCTP domain ID
     * @param sender The sender on the source chain (TokenMessenger address)
     * @param finalityThresholdExecuted The finality threshold that was met
     * @param messageBody The BurnMessageV2 content
     */
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody,
        address relayerAddress
    ) external returns (bool) {
        require(msg.sender == messageTransmitter, "Only MessageTransmitter");

        // Decode BurnMessageV2 to get amount, feeExecuted, and hookData
        (
            uint256 amount,
            uint256 feeExecuted,
            bytes memory hookData
        ) = BurnMessageV2.decodeForHook(messageBody);

        // Calculate actual mint amount (feeExecuted = maxFee set at burn time)
        uint256 actualMintAmount = amount - feeExecuted;

        // Get mint recipient from message
        bytes32 mintRecipientBytes = BurnMessageV2.getMintRecipient(messageBody);
        address recipient = MessageV2.bytes32ToAddress(mintRecipientBytes);

        // Mint tokens to recipient
        IMockMintable(usdc).mint(recipient, actualMintAmount);

        // Mint fee to relayer (simulates CCTP protocol-level fee payment)
        if (feeExecuted > 0 && relayerAddress != address(0)) {
            IMockMintable(usdc).mint(relayerAddress, feeExecuted);
        }

        // If recipient is a contract and there's hook data, call the handler
        if (_isContract(recipient) && hookData.length > 0) {
            // Determine which handler to call based on finality
            if (finalityThresholdExecuted >= CCTPFinality.STANDARD) {
                IMessageHandlerV2(recipient).handleReceiveFinalizedMessage(
                    sourceDomain,
                    sender,
                    finalityThresholdExecuted,
                    messageBody
                );
            } else {
                IMessageHandlerV2(recipient).handleReceiveUnfinalizedMessage(
                    sourceDomain,
                    sender,
                    finalityThresholdExecuted,
                    messageBody
                );
            }
        }

        return true;
    }

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(addr) }
        return size > 0;
    }
}

/**
 * @title MockMessageTransmitterV2
 * @notice Simulates Circle's MessageTransmitterV2 for local testing
 * @dev Handles message passing between chains. In real CCTP, this involves
 *      attestations from Circle's attestation service. Here we skip attestation
 *      verification but use the same message format.
 *
 * Message Format (MessageV2):
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

/**
 * @dev Struct to avoid stack too deep in sendMessageForBurn
 */
struct BurnMessageParams {
    uint32 destinationDomain;
    bytes32 destinationTokenMessenger;
    bytes32 destinationCaller;
    uint64 burnNonce;
    address burnToken;
    bytes32 mintRecipient;
    uint256 amount;
    bytes32 messageSender;
    uint256 maxFee;
    uint32 minFinalityThreshold;
}

contract MockMessageTransmitterV2 is IMessageTransmitterV2 {
    // Local domain ID
    uint32 public immutable override localDomain;

    // Token messenger that can send messages
    address public tokenMessenger;

    // Relayer address (simulates Circle's attestation service)
    address public relayer;

    // Processed message hashes (replay protection using keccak256(sourceDomain, nonce))
    mapping(bytes32 => bool) public usedNonces;

    // Message nonce counter
    uint64 public nextMessageNonce;

    // Events - keeping indexed fields for relayer convenience
    // Note: Real CCTP emits `event MessageSent(bytes message)` with full message bytes
    // We keep the indexed version for easier local relayer parsing
    event MessageSent(
        uint64 indexed nonce,
        uint32 indexed sourceDomain,
        uint32 indexed destinationDomain,
        bytes32 sender,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes messageBody
    );

    event MessageReceived(
        uint64 indexed nonce,
        uint32 indexed sourceDomain,
        bytes32 indexed sender,
        uint32 finalityThresholdExecuted
    );

    constructor(uint32 _localDomain, address _relayer) {
        localDomain = _localDomain;
        relayer = _relayer;
    }

    /**
     * @notice Set the token messenger address
     */
    function setTokenMessenger(address _tokenMessenger) external {
        require(tokenMessenger == address(0), "Already set");
        tokenMessenger = _tokenMessenger;
    }

    /**
     * @notice Set relayer address
     */
    function setRelayer(address _relayer) external {
        require(msg.sender == relayer, "Only relayer");
        relayer = _relayer;
    }

    /**
     * @notice Called by TokenMessenger to send a burn message
     * @dev This emits the event that our relayer watches
     */
    function sendMessageForBurn(
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller,
        uint64 burnNonce,
        address burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        bytes32 messageSender,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes memory hookData
    ) external {
        require(msg.sender == tokenMessenger, "Only TokenMessenger");

        // Use struct to avoid stack too deep
        BurnMessageParams memory params = BurnMessageParams({
            destinationDomain: destinationDomain,
            destinationTokenMessenger: destinationTokenMessenger,
            destinationCaller: destinationCaller,
            burnNonce: burnNonce,
            burnToken: burnToken,
            mintRecipient: mintRecipient,
            amount: amount,
            messageSender: messageSender,
            maxFee: maxFee,
            minFinalityThreshold: minFinalityThreshold
        });

        _emitBurnMessage(params, hookData);
    }

    /**
     * @dev Internal helper to emit MessageSent event, avoiding stack too deep
     */
    function _emitBurnMessage(BurnMessageParams memory params, bytes memory hookData) internal {
        uint64 nonce = nextMessageNonce++;

        // Encode the BurnMessageV2 body
        bytes memory messageBody = BurnMessageV2.encode(
            MessageV2.addressToBytes32(params.burnToken),
            params.mintRecipient,
            params.amount,
            params.messageSender,
            params.maxFee,
            params.maxFee,  // feeExecuted = maxFee (mock simulates relayer claiming full fee)
            0,  // expirationBlock - always 0 for standard finality
            hookData
        );

        emit MessageSent(
            nonce,
            localDomain,
            params.destinationDomain,
            MessageV2.addressToBytes32(tokenMessenger),
            params.destinationTokenMessenger,
            params.destinationCaller,
            params.minFinalityThreshold,
            messageBody
        );
    }

    /**
     * @inheritdoc IMessageTransmitterV2
     * @dev Receives a message in the full MessageV2 format.
     *      In real CCTP, this verifies Circle's attestation signature.
     *      Here we skip attestation verification but validate the message format.
     *
     * @param message Full MessageV2 encoded bytes
     * @param attestation Ignored in mock (real CCTP requires valid signature)
     */
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success) {
        // In mock, we allow relayer OR anyone (for testing flexibility)
        // Real CCTP doesn't have this restriction - anyone can call with valid attestation
        require(msg.sender == relayer, "Mock: Only relayer");

        // Attestation is ignored in mock (real CCTP verifies signature here)
        // We accept any attestation, including empty bytes
        (attestation);

        // Validate and process message using individual getters (to avoid stack-too-deep)
        _validateAndProcessMessage(message);

        return true;
    }

    /**
     * @dev Internal function to validate and process message, avoiding stack too deep
     */
    function _validateAndProcessMessage(bytes calldata message) internal {
        // Validate message version
        require(MessageV2.getVersion(message) == MessageV2.MESSAGE_VERSION, "Invalid message version");

        // Validate destination domain matches local domain
        require(MessageV2.getDestinationDomain(message) == localDomain, "Wrong destination domain");

        // Validate destinationCaller (same logic as real CCTP)
        // - bytes32(0) = anyone can call receiveMessage
        // - specificAddress = only that address can call receiveMessage
        bytes32 destinationCaller = MessageV2.getDestinationCaller(message);
        require(
            destinationCaller == bytes32(0) ||
            destinationCaller == MessageV2.addressToBytes32(msg.sender),
            "Invalid destination caller"
        );

        // Get fields needed for processing
        uint32 sourceDomain = MessageV2.getSourceDomain(message);
        uint64 nonce = MessageV2.getNonce(message);

        // Check replay protection using (sourceDomain, nonce)
        bytes32 nonceKey = keccak256(abi.encodePacked(sourceDomain, nonce));
        require(!usedNonces[nonceKey], "Message already processed");
        usedNonces[nonceKey] = true;

        // Get remaining fields for event and handler
        bytes32 sender = MessageV2.getSender(message);
        uint32 finalityThresholdExecuted = MessageV2.getFinalityThresholdExecuted(message);

        emit MessageReceived(nonce, sourceDomain, sender, finalityThresholdExecuted);

        // Forward to TokenMessenger to handle minting
        // The recipient in the message header is the remote TokenMessenger
        // The actual mint recipient is inside the BurnMessageV2 body
        MockTokenMessengerV2(tokenMessenger).handleReceiveMessage(
            sourceDomain,
            sender,
            finalityThresholdExecuted,
            MessageV2.getMessageBody(message),
            msg.sender  // relayer address (for CCTP fee payment)
        );
    }
}

/**
 * @title IMockBurnable
 * @notice Interface for mock token burning
 */
interface IMockBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title IMockMintable
 * @notice Interface for mock token minting
 */
interface IMockMintable {
    function mint(address to, uint256 amount) external;
}

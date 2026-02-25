// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./ICCTPV2.sol";

/**
 * @title CCTPHookRouter
 * @notice Atomically wraps CCTP receiveMessage() + hook dispatch in a single transaction
 * @dev Circle's real CCTP v2 does NOT auto-dispatch hooks. The hookData in BurnMessageV2
 *      is treated as opaque metadata — TokenMessenger mints USDC to the mintRecipient but
 *      never calls handleReceiveFinalizedMessage on the recipient.
 *
 *      This contract solves that by:
 *      1. Calling messageTransmitter.receiveMessage() — mints USDC to mintRecipient
 *      2. Calling handleReceiveFinalizedMessage() on the mintRecipient — processes the hook
 *
 *      If the hook call reverts, the entire transaction reverts (no stranded funds).
 *
 *      Deployed on every chain (hub + each client). The relayer calls relayWithHook()
 *      instead of receiveMessage() directly.
 *
 *      Reference: https://github.com/zklim/HooksOnHooks
 */
contract CCTPHookRouter {
    /// @notice CCTP MessageTransmitter contract
    IMessageTransmitterV2 public immutable messageTransmitter;

    constructor(address _messageTransmitter) {
        require(_messageTransmitter != address(0), "CCTPHookRouter: zero address");
        messageTransmitter = IMessageTransmitterV2(_messageTransmitter);
    }

    /**
     * @notice Relay a CCTP message and dispatch the hook atomically
     * @dev Reverts if either receiveMessage or hook dispatch fails (no stranded funds)
     * @param message Full MessageV2 encoded bytes
     * @param attestation Circle attestation signature(s), or empty for mock
     * @return success Always true on success (reverts on failure)
     */
    function relayWithHook(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool) {
        // 1. Call receiveMessage — mints USDC to mintRecipient
        messageTransmitter.receiveMessage(message, attestation);

        // 2. Extract routing fields from the MessageV2 envelope
        uint32 sourceDomain = MessageV2.getSourceDomain(message);
        bytes32 sender = MessageV2.getSender(message);
        uint32 finality = MessageV2.getFinalityThresholdExecuted(message);
        bytes calldata messageBody = MessageV2.getMessageBody(message);

        // 3. Get mintRecipient from BurnMessageV2 (the pool contract)
        address recipient = MessageV2.bytes32ToAddress(
            BurnMessageV2.getMintRecipient(messageBody)
        );

        // 4. Dispatch hook — if this reverts, entire tx reverts (no stranded funds)
        IMessageHandlerV2(recipient).handleReceiveFinalizedMessage(
            sourceDomain,
            sender,
            finality,
            messageBody
        );

        return true;
    }
}

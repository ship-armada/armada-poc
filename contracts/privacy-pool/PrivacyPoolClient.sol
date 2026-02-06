// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IPrivacyPoolClient.sol";
import "./types/CCTPTypes.sol";
import "../cctp/ICCTPV2.sol";

/**
 * @title PrivacyPoolClient
 * @notice Client chain contract for cross-chain privacy pool operations
 * @dev Thin bridge contract that routes USDC to/from the Hub PrivacyPool.
 *      Implements IMessageHandlerV2 to receive CCTP messages from Hub.
 *
 *      This contract does NOT hold any shielded state - all privacy pool
 *      state is maintained on the Hub chain. This contract only:
 *      1. Initiates cross-chain shields (burns USDC, sends to Hub)
 *      2. Receives cross-chain unshields (receives USDC from Hub, delivers to recipient)
 */
contract PrivacyPoolClient is IPrivacyPoolClient {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Whether the contract has been initialized
    bool public initialized;

    /// @notice CCTP TokenMessenger address
    address public override tokenMessenger;

    /// @notice CCTP MessageTransmitter address
    address public override messageTransmitter;

    /// @notice USDC token address
    address public override usdc;

    /// @notice This chain's CCTP domain ID
    uint32 public override localDomain;

    /// @notice Hub chain's CCTP domain ID
    uint32 public override hubDomain;

    /// @notice Hub PrivacyPool address (as bytes32 for CCTP compatibility)
    bytes32 public override hubPool;

    /// @notice Contract owner
    address public override owner;

    // ══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initialize the PrivacyPoolClient contract
     * @param _tokenMessenger CCTP TokenMessenger address
     * @param _messageTransmitter CCTP MessageTransmitter address
     * @param _usdc USDC token address
     * @param _localDomain This chain's CCTP domain ID
     * @param _hubDomain Hub chain's CCTP domain ID
     * @param _hubPool Hub PrivacyPool address (as bytes32)
     * @param _owner Contract owner
     */
    function initialize(
        address _tokenMessenger,
        address _messageTransmitter,
        address _usdc,
        uint32 _localDomain,
        uint32 _hubDomain,
        bytes32 _hubPool,
        address _owner
    ) external override {
        require(!initialized, "PrivacyPoolClient: Already initialized");

        tokenMessenger = _tokenMessenger;
        messageTransmitter = _messageTransmitter;
        usdc = _usdc;
        localDomain = _localDomain;
        hubDomain = _hubDomain;
        hubPool = _hubPool;
        owner = _owner;

        initialized = true;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // USER-FACING OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initiate a cross-chain shield to the Hub
     * @dev Burns USDC via CCTP with hook data containing shield parameters.
     *      The Hub will receive this message and create a commitment in its merkle tree.
     *
     *      Flow:
     *      1. Transfer USDC from user to this contract
     *      2. Approve TokenMessenger to spend USDC
     *      3. Call depositForBurnWithHook to burn USDC and send message to Hub
     *      4. Hub receives message, processes shield, adds commitment to tree
     *
     * @param amount Amount of USDC to shield
     * @param maxFee Maximum CCTP relayer fee (deducted at protocol level, 0 = no fee)
     * @param npk Note public key (recipient's key for claiming the note)
     * @param encryptedBundle Encrypted note data [3 x bytes32]
     * @param shieldKey Shield key for decryption by recipient
     * @param destinationCaller Address allowed to call receiveMessage on Hub (bytes32).
     *        Use bytes32(0) to allow any relayer, or specify a relayer address for MEV protection.
     * @return nonce CCTP message nonce
     */
    function crossChainShield(
        uint256 amount,
        uint256 maxFee,
        bytes32 npk,
        bytes32[3] calldata encryptedBundle,
        bytes32 shieldKey,
        bytes32 destinationCaller
    ) external override returns (uint64) {
        require(amount > 0, "PrivacyPoolClient: Amount must be > 0");
        require(maxFee < amount, "PrivacyPoolClient: Fee exceeds amount");
        require(hubPool != bytes32(0), "PrivacyPoolClient: Hub not configured");

        // Transfer USDC from user to this contract
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);

        // Approve TokenMessenger to spend USDC
        IERC20(usdc).approve(tokenMessenger, amount);

        // Create shield data payload
        // value = gross amount (CCTP deducts fee at protocol level before minting)
        ShieldData memory shieldData = ShieldData({
            npk: npk,
            value: uint120(amount),
            encryptedBundle: encryptedBundle,
            shieldKey: shieldKey
        });

        // Encode the CCTP payload
        bytes memory hookData = CCTPPayloadLib.encodeShield(shieldData);

        // Burn USDC and send message to Hub
        // The Hub is the mint recipient and message handler
        // destinationCaller restricts who can call receiveMessage on the destination chain
        uint64 nonce = ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(
            amount,
            hubDomain,
            hubPool,                   // mintRecipient - Hub receives the USDC
            usdc,
            destinationCaller,         // destinationCaller - relayer address or 0 for any
            maxFee,                    // maxFee - CCTP relayer fee (deducted from mint amount)
            CCTPFinality.STANDARD,     // minFinalityThreshold - use standard finality
            hookData                   // hookData - contains shield parameters
        );

        emit CrossChainShieldInitiated(msg.sender, amount, npk, nonce);

        return nonce;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CCTP V2 MESSAGE HANDLER
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Handle finalized CCTP message (cross-chain unshields from Hub)
     * @dev Called by TokenMessenger after CCTP attestation is verified and tokens minted.
     *      USDC has already been minted to this contract by CCTP.
     *      We decode the message and forward USDC to the final recipient.
     *
     *      Message format: BurnMessageV2 (see ICCTPV2.sol for byte layout)
     *      - amount: Gross amount before fee deduction
     *      - feeExecuted: Fee deducted (actualMint = amount - feeExecuted)
     *      - hookData: Our CCTPPayload with unshield data
     *
     * @param remoteDomain Source chain's CCTP domain
     * @param sender Sender address on source chain (as bytes32, typically remote TokenMessenger)
     * @param finalityThresholdExecuted The finality threshold that was met (>=2000 for finalized)
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function handleReceiveFinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool) {
        // Only accept from TokenMessenger (which is called by MessageTransmitter)
        // In CCTP V2, TokenMessenger handles the token minting and then calls the recipient's handler
        require(msg.sender == tokenMessenger, "PrivacyPoolClient: Only TokenMessenger");

        // Verify finality threshold (should be >= 2000 for finalized messages)
        require(finalityThresholdExecuted >= CCTPFinality.STANDARD, "PrivacyPoolClient: Insufficient finality");

        // Verify the message comes from the Hub domain
        require(remoteDomain == hubDomain, "PrivacyPoolClient: Invalid domain");

        // Silence unused variable warning
        (sender);

        // Decode the BurnMessageV2 to get amount, feeExecuted, and hookData
        (
            uint256 grossAmount,
            uint256 feeExecuted,
            bytes memory hookData
        ) = BurnMessageV2.decodeForHook(messageBody);

        // Calculate actual amount received (gross - fee)
        // In local mock, feeExecuted is always 0. On real CCTP, fee may be deducted.
        uint256 actualAmount = grossAmount - feeExecuted;

        // Decode our CCTP payload
        CCTPPayload memory payload = CCTPPayloadLib.decode(hookData);

        // Route based on message type
        if (payload.messageType == MessageType.UNSHIELD) {
            // Cross-chain unshield from Hub
            UnshieldData memory unshieldData = CCTPPayloadLib.decodeUnshieldData(payload.data);

            // Transfer USDC to the final recipient
            // USDC was minted to this contract by CCTP
            IERC20(usdc).safeTransfer(unshieldData.recipient, actualAmount);

            emit UnshieldReceived(unshieldData.recipient, actualAmount);
        } else {
            // Client should not receive SHIELD messages (only Hub receives those)
            revert("PrivacyPoolClient: Invalid message type");
        }

        return true;
    }

    /**
     * @notice Handle unfinalized CCTP message (fast finality)
     * @dev We don't support fast finality in the POC
     */
    function handleReceiveUnfinalizedMessage(
        uint32,
        bytes32,
        uint32,
        bytes calldata
    ) external pure override returns (bool) {
        revert("PrivacyPoolClient: Fast finality not supported");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update the Hub pool configuration
     * @param _hubDomain Hub chain's CCTP domain ID
     * @param _hubPool Hub PrivacyPool address (as bytes32)
     */
    function setHubPool(uint32 _hubDomain, bytes32 _hubPool) external override {
        require(msg.sender == owner, "PrivacyPoolClient: Only owner");
        hubDomain = _hubDomain;
        hubPool = _hubPool;
        emit HubPoolSet(_hubDomain, _hubPool);
    }
}

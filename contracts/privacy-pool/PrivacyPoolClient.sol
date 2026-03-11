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

    /// @notice CCTP Hook Router address (authorized to call handleReceiveFinalizedMessage)
    address public override hookRouter;

    /// @notice Default finality threshold for outbound CCTP burns (STANDARD=2000, FAST=1000)
    /// @dev Used as fallback when user passes 0 to crossChainShield
    uint32 public defaultFinalityThreshold;

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
     * @param minFinalityThreshold Finality level for this transfer:
     *        CCTPFinality.FAST (1000) = ~8-20s, 1-1.3 bps fee (Circle bears reorg risk)
     *        CCTPFinality.STANDARD (2000) = ~15-19 min, free
     *        0 = use contract's defaultFinalityThreshold (falls back to STANDARD if unset)
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
        uint32 minFinalityThreshold,
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
        IERC20(usdc).safeApprove(tokenMessenger, 0);
        IERC20(usdc).safeApprove(tokenMessenger, amount);

        // Encode shield payload and execute CCTP burn in helper (avoids stack-too-deep)
        _executeCCTPShield(amount, maxFee, minFinalityThreshold, npk, encryptedBundle, shieldKey, destinationCaller);

        emit CrossChainShieldInitiated(msg.sender, amount, npk, 0);

        return 0;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CCTP V2 MESSAGE HANDLER
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Handle finalized CCTP message (cross-chain unshields from Hub)
     * @dev Called by CCTPHookRouter (or TokenMessenger in mock mode) after CCTP message
     *      is received and tokens minted. USDC has already been minted to this contract.
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
        require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPoolClient: Unauthorized caller");
        require(finalityThresholdExecuted >= CCTPFinality.STANDARD, "PrivacyPoolClient: Insufficient finality");
        require(remoteDomain == hubDomain, "PrivacyPoolClient: Invalid domain");
        (sender); // Silence unused variable warning

        return _handleCCTPMessage(messageBody);
    }

    /**
     * @notice Handle unfinalized CCTP message (fast finality / "confirmed" level)
     * @dev Called by CCTPHookRouter when finalityThresholdExecuted < STANDARD (2000).
     *      Circle bears the reorg risk for fast transfers via off-chain insurance.
     *      Always accepted — users choose fast vs standard finality per-transaction.
     *
     * @param remoteDomain Source chain's CCTP domain
     * @param sender Sender address on source chain (as bytes32)
     * @param finalityThresholdExecuted The finality threshold that was met (e.g. 1000 for FAST)
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function handleReceiveUnfinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external override returns (bool) {
        require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPoolClient: Unauthorized caller");
        require(finalityThresholdExecuted >= CCTPFinality.FAST, "PrivacyPoolClient: Finality below minimum");
        require(remoteDomain == hubDomain, "PrivacyPoolClient: Invalid domain");
        (sender); // Silence unused variable warning

        return _handleCCTPMessage(messageBody);
    }

    /**
     * @notice Shared CCTP message processing logic for both finalized and unfinalized paths
     * @param messageBody BurnMessageV2 encoded message containing hookData
     * @return success Always returns true on success (reverts on failure)
     */
    function _handleCCTPMessage(bytes calldata messageBody) internal returns (bool) {
        // Decode the BurnMessageV2 to get amount, feeExecuted, and hookData
        (
            uint256 grossAmount,
            uint256 feeExecuted,
            bytes memory hookData
        ) = BurnMessageV2.decodeForHook(messageBody);

        // Calculate actual amount received (gross - fee)
        // In local mock, feeExecuted may equal maxFee. On real CCTP, fee is set by attestation service.
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
     * @notice Encode shield data and execute CCTP burn (extracted to avoid stack-too-deep)
     */
    function _executeCCTPShield(
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes32 npk,
        bytes32[3] calldata encryptedBundle,
        bytes32 shieldKey,
        bytes32 destinationCaller
    ) internal {
        bytes memory hookData = CCTPPayloadLib.encodeShield(ShieldData({
            npk: npk,
            value: uint120(amount),
            encryptedBundle: encryptedBundle,
            shieldKey: shieldKey
        }));

        ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(
            amount,
            hubDomain,
            hubPool,
            usdc,
            destinationCaller,
            maxFee,
            _resolveFinality(minFinalityThreshold),
            hookData
        );
    }

    /**
     * @notice Resolve finality threshold from user param, contract default, or STANDARD fallback
     * @param requested User-supplied threshold (0 = use default)
     * @return finality Resolved finality threshold
     */
    function _resolveFinality(uint32 requested) internal view returns (uint32) {
        if (requested > 0) {
            require(
                requested == CCTPFinality.FAST || requested == CCTPFinality.STANDARD,
                "PrivacyPoolClient: Invalid finality threshold"
            );
            return requested;
        }
        if (defaultFinalityThreshold > 0) {
            return defaultFinalityThreshold;
        }
        return CCTPFinality.STANDARD;
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

    /**
     * @notice Set the CCTP Hook Router address
     * @dev The hook router is authorized to call handleReceiveFinalizedMessage
     *      after atomically calling receiveMessage on the MessageTransmitter
     * @param _hookRouter Address of the CCTPHookRouter contract
     */
    function setHookRouter(address _hookRouter) external override {
        require(msg.sender == owner, "PrivacyPoolClient: Only owner");
        hookRouter = _hookRouter;
    }

    /**
     * @notice Set the default finality threshold for outbound CCTP burns
     * @dev Controls whether cross-chain shields request fast or standard finality.
     *      STANDARD (2000) = wait for hard finality (~15-19 min), no fee.
     *      FAST (1000) = soft finality (~8-20 sec), 1-1.3 bps fee.
     * @param _threshold Finality threshold (must be FAST or STANDARD)
     */
    function setDefaultFinalityThreshold(uint32 _threshold) external override {
        require(msg.sender == owner, "PrivacyPoolClient: Only owner");
        require(
            _threshold == CCTPFinality.FAST || _threshold == CCTPFinality.STANDARD,
            "PrivacyPoolClient: Invalid threshold"
        );
        defaultFinalityThreshold = _threshold;
        emit DefaultFinalityThresholdSet(_threshold);
    }
}

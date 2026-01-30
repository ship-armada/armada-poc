// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./cctp/ICCTPV2.sol";
import "./railgun/interfaces/IUnshieldCallback.sol";

/**
 * @title HubUnshieldProxyV3
 * @notice Bridge for cross-chain unshield using CCTP V2
 * @dev Converts Hub USDC to Client chain USDC via Circle CCTP
 *
 * Supports two flows:
 *
 * Flow A (Two transactions - manual):
 *   1. User unshields from Railgun to their own address
 *   2. User approves this contract and calls bridgeTo()
 *   3. This contract calls TokenMessengerV2.depositForBurn()
 *   4. CCTP attestation service attests the message
 *   5. Relayer calls receiveMessage() on destination MessageTransmitter
 *   6. User receives USDC on client chain
 *
 * Flow B (Single transaction - callback):
 *   1. User unshields from Railgun to THIS CONTRACT as recipient
 *   2. Railgun calls onRailgunUnshield() callback
 *   3. Callback automatically bridges to originalSender on default destination
 *   4. CCTP attestation + relay happens
 *   5. User receives USDC on client chain
 *
 * Note: Unshield doesn't need hookData since it's just a simple transfer,
 * so we use depositForBurn() instead of depositForBurnWithHook().
 */
contract HubUnshieldProxyV3 is IUnshieldCallback {
    using SafeERC20 for IERC20;

    // CCTP V2 contracts
    address public immutable tokenMessenger;
    address public immutable usdc;

    // Default destination (can be overridden per-call)
    uint32 public defaultDestinationDomain;

    // CCTP settings
    uint256 public maxFee;
    uint32 public minFinalityThreshold;

    // Railgun contract (for callback validation)
    address public railgunSmartWallet;

    // Events
    event BridgeInitiated(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint32 destinationDomain,
        uint64 nonce
    );

    event UnshieldCallbackBridge(
        address indexed originalSender,
        uint256 amount,
        uint32 destinationDomain,
        uint64 nonce
    );

    event ConfigUpdated(
        uint32 defaultDestinationDomain,
        uint256 maxFee,
        uint32 minFinalityThreshold
    );

    // Owner for configuration
    address public owner;

    constructor(
        address _tokenMessenger,
        address _usdc,
        uint32 _defaultDestinationDomain,
        address _railgunSmartWallet
    ) {
        tokenMessenger = _tokenMessenger;
        usdc = _usdc;
        defaultDestinationDomain = _defaultDestinationDomain;
        railgunSmartWallet = _railgunSmartWallet;
        maxFee = 0;
        minFinalityThreshold = CCTPFinality.STANDARD;
        owner = msg.sender;
    }

    /**
     * @notice Bridge USDC from Hub to default client chain
     * @param amount Amount of USDC to bridge
     * @param recipient Address to receive USDC on client chain
     * @return nonce The CCTP nonce for tracking
     */
    function bridgeToClient(
        uint256 amount,
        address recipient
    ) external returns (uint64 nonce) {
        return bridgeTo(amount, recipient, defaultDestinationDomain);
    }

    /**
     * @notice Bridge USDC to any supported chain
     * @param amount Amount of USDC to bridge
     * @param recipient Address to receive USDC on destination chain
     * @param destinationDomain Circle domain ID of destination chain
     * @return nonce The CCTP nonce for tracking
     */
    function bridgeTo(
        uint256 amount,
        address recipient,
        uint32 destinationDomain
    ) public returns (uint64 nonce) {
        require(amount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");
        require(destinationDomain != 0, "Invalid domain");

        // Transfer USDC from user to this contract
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);

        // Approve TokenMessenger
        IERC20(usdc).safeApprove(tokenMessenger, 0);
        IERC20(usdc).safeApprove(tokenMessenger, amount);

        // Convert recipient address to bytes32
        bytes32 mintRecipient = bytes32(uint256(uint160(recipient)));

        // Call CCTP V2 depositForBurn (no hook data needed for simple transfer)
        nonce = ITokenMessengerV2(tokenMessenger).depositForBurn(
            amount,
            destinationDomain,
            mintRecipient,
            usdc,
            bytes32(0),              // destinationCaller: anyone can relay
            maxFee,
            minFinalityThreshold
        );

        emit BridgeInitiated(
            msg.sender,
            recipient,
            amount,
            destinationDomain,
            nonce
        );

        return nonce;
    }

    /**
     * @notice Callback from Railgun when tokens are unshielded to this contract
     * @dev Automatically bridges received USDC to the originalSender on the default destination chain
     * @param token The ERC20 token address (must be USDC)
     * @param amount The amount received
     * @param originalSender The wallet that initiated the Railgun unshield tx
     */
    function onRailgunUnshield(
        address token,
        uint120 amount,
        address originalSender
    ) external override {
        // Only accept callbacks from Railgun
        require(msg.sender == railgunSmartWallet, "Only Railgun");

        // Only handle USDC
        require(token == usdc, "Only USDC supported");

        // Must have a valid destination
        require(defaultDestinationDomain != 0, "No default destination");

        // Approve TokenMessenger to spend the received USDC
        IERC20(usdc).safeApprove(tokenMessenger, 0);
        IERC20(usdc).safeApprove(tokenMessenger, amount);

        // Convert originalSender to bytes32 for CCTP
        bytes32 mintRecipient = bytes32(uint256(uint160(originalSender)));

        // Bridge to the original sender on the default destination chain
        uint64 nonce = ITokenMessengerV2(tokenMessenger).depositForBurn(
            amount,
            defaultDestinationDomain,
            mintRecipient,
            usdc,
            bytes32(0),              // destinationCaller: anyone can relay
            maxFee,
            minFinalityThreshold
        );

        emit UnshieldCallbackBridge(
            originalSender,
            amount,
            defaultDestinationDomain,
            nonce
        );
    }

    /**
     * @notice Update default destination domain
     */
    function setDefaultDestination(uint32 domain) external {
        require(msg.sender == owner, "Only owner");
        defaultDestinationDomain = domain;
        emit ConfigUpdated(defaultDestinationDomain, maxFee, minFinalityThreshold);
    }

    /**
     * @notice Update Railgun contract address
     */
    function setRailgunSmartWallet(address _railgunSmartWallet) external {
        require(msg.sender == owner, "Only owner");
        railgunSmartWallet = _railgunSmartWallet;
    }

    /**
     * @notice Update CCTP finality settings
     */
    function setFinalitySettings(uint256 _maxFee, uint32 _minFinalityThreshold) external {
        require(msg.sender == owner, "Only owner");
        require(
            _minFinalityThreshold == CCTPFinality.FAST ||
            _minFinalityThreshold == CCTPFinality.STANDARD,
            "Invalid threshold"
        );
        maxFee = _maxFee;
        minFinalityThreshold = _minFinalityThreshold;
        emit ConfigUpdated(defaultDestinationDomain, maxFee, minFinalityThreshold);
    }

    /**
     * @notice Emergency withdraw stuck funds
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external {
        require(msg.sender == owner, "Only owner");
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Transfer ownership
     */
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Only owner");
        owner = newOwner;
    }
}

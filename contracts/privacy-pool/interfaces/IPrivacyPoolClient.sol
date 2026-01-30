// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../cctp/ICCTPV2.sol";

/**
 * @title IPrivacyPoolClient
 * @notice Interface for the Client chain PrivacyPoolClient contract
 * @dev Thin bridge contract that routes USDC to/from the Hub PrivacyPool
 */
interface IPrivacyPoolClient is IMessageHandlerV2 {
    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a cross-chain shield is initiated
     * @param sender Address that initiated the shield
     * @param amount Amount of USDC being shielded
     * @param npk Note public key
     * @param nonce CCTP message nonce
     */
    event CrossChainShieldInitiated(
        address indexed sender,
        uint256 amount,
        bytes32 indexed npk,
        uint64 nonce
    );

    /**
     * @notice Emitted when an unshield is received from Hub
     * @param recipient Address receiving the USDC
     * @param amount Amount of USDC received
     */
    event UnshieldReceived(
        address indexed recipient,
        uint256 amount
    );

    /**
     * @notice Emitted when Hub pool configuration is updated
     * @param hubDomain CCTP domain of the Hub
     * @param hubPool Address of the Hub PrivacyPool (as bytes32)
     */
    event HubPoolSet(uint32 hubDomain, bytes32 hubPool);

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
    ) external;

    // ══════════════════════════════════════════════════════════════════════════
    // USER-FACING OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initiate a cross-chain shield to the Hub
     * @dev Burns USDC via CCTP, Hub will create commitment in merkle tree
     *
     * @param amount Amount of USDC to shield
     * @param npk Note public key
     * @param encryptedBundle Encrypted note data [3 x bytes32]
     * @param shieldKey Shield key for decryption
     * @param destinationCaller Address allowed to call receiveMessage on Hub (bytes32).
     *        Use bytes32(0) to allow any relayer, or specify a relayer address for MEV protection.
     * @return nonce CCTP message nonce
     */
    function crossChainShield(
        uint256 amount,
        bytes32 npk,
        bytes32[3] calldata encryptedBundle,
        bytes32 shieldKey,
        bytes32 destinationCaller
    ) external returns (uint64 nonce);

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update the Hub pool configuration
     * @param _hubDomain Hub chain's CCTP domain ID
     * @param _hubPool Hub PrivacyPool address (as bytes32)
     */
    function setHubPool(uint32 _hubDomain, bytes32 _hubPool) external;

    // ══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice CCTP TokenMessenger address
    function tokenMessenger() external view returns (address);

    /// @notice CCTP MessageTransmitter address
    function messageTransmitter() external view returns (address);

    /// @notice USDC token address
    function usdc() external view returns (address);

    /// @notice This chain's CCTP domain ID
    function localDomain() external view returns (uint32);

    /// @notice Hub chain's CCTP domain ID
    function hubDomain() external view returns (uint32);

    /// @notice Hub PrivacyPool address (as bytes32)
    function hubPool() external view returns (bytes32);

    /// @notice Contract owner
    function owner() external view returns (address);
}

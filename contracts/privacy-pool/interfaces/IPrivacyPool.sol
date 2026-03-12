// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../railgun/logic/Globals.sol";
import "../../cctp/ICCTPV2.sol";

/**
 * @title IPrivacyPool
 * @notice Interface for the Hub PrivacyPool contract
 * @dev Main entry point for privacy pool operations on the Hub chain
 */
interface IPrivacyPool is IMessageHandlerV2 {
    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a remote pool address is configured
    event RemotePoolSet(uint32 indexed domain, bytes32 poolAddress);

    /// @notice Emitted when a remote hook router address is configured
    event RemoteHookRouterSet(uint32 indexed domain, bytes32 routerAddress);

    /// @notice Emitted when testing mode is changed
    event TestingModeSet(bool enabled);

    /// @notice Emitted when default finality threshold is changed
    event DefaultFinalityThresholdSet(uint32 threshold);

    // ══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initialize the PrivacyPool contract
     * @param _shieldModule Address of ShieldModule implementation
     * @param _transactModule Address of TransactModule implementation
     * @param _merkleModule Address of MerkleModule implementation
     * @param _verifierModule Address of VerifierModule implementation
     * @param _tokenMessenger CCTP TokenMessenger address
     * @param _messageTransmitter CCTP MessageTransmitter address
     * @param _usdc USDC token address
     * @param _localDomain This chain's CCTP domain ID
     * @param _owner Contract owner
     */
    function initialize(
        address _shieldModule,
        address _transactModule,
        address _merkleModule,
        address _verifierModule,
        address _tokenMessenger,
        address _messageTransmitter,
        address _usdc,
        uint32 _localDomain,
        address _owner
    ) external;

    // ══════════════════════════════════════════════════════════════════════════
    // USER-FACING OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Shield tokens into the privacy pool (local, same chain)
     * @param _shieldRequests Array of shield requests
     */
    function shield(ShieldRequest[] calldata _shieldRequests) external;

    /**
     * @notice Execute private transactions (transfers and/or unshields)
     * @param _transactions Array of transactions to process
     */
    function transact(Transaction[] calldata _transactions) external;

    /**
     * @notice Atomic cross-chain unshield to a client chain
     * @param _transaction Transaction with unshield proof
     * @param destinationDomain Target client chain's CCTP domain
     * @param finalRecipient Address to receive USDC on client chain
     * @param maxFee Maximum CCTP relayer fee in USDC raw units (deducted from burn amount at protocol level, 0 = no fee)
     * @return nonce CCTP message nonce
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        uint256 maxFee
    ) external returns (uint64 nonce);

    // ══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Set the address of a remote PrivacyPool/Client
     * @param domain CCTP domain ID of the remote chain
     * @param poolAddress Address of the remote contract (as bytes32)
     */
    function setRemotePool(uint32 domain, bytes32 poolAddress) external;

    /**
     * @notice Set the CCTPHookRouter address for a remote chain
     * @param domain CCTP domain ID of the remote chain
     * @param routerAddress CCTPHookRouter address on the remote chain (as bytes32)
     */
    function setRemoteHookRouter(uint32 domain, bytes32 routerAddress) external;

    /**
     * @notice Set a verification key for a circuit configuration
     * @param nullifiers Number of nullifiers
     * @param commitments Number of commitments
     * @param key The verification key
     */
    function setVerificationKey(
        uint256 nullifiers,
        uint256 commitments,
        VerifyingKey calldata key
    ) external;

    /**
     * @notice Set the shield fee in basis points
     * @param feeBps Fee in basis points (50 = 0.50%)
     */
    function setShieldFee(uint120 feeBps) external;

    /**
     * @notice Set the unshield fee in basis points
     * @param feeBps Fee in basis points (50 = 0.50%)
     */
    function setUnshieldFee(uint120 feeBps) external;

    /**
     * @notice Set the treasury address for fee collection
     * @param _treasury Address to receive protocol fees
     */
    function setTreasury(address payable _treasury) external;

    /**
     * @notice Enable or disable testing mode
     * @dev POC ONLY - bypasses SNARK verification
     * @param enabled Whether to enable testing mode
     */
    function setTestingMode(bool enabled) external;

    /**
     * @notice Set privileged shield caller (bypasses shield/unshield fees)
     * @param caller Address to configure (e.g. yield adapter)
     * @param privileged True to exempt from fees
     */
    function setPrivilegedShieldCaller(address caller, bool privileged) external;

    /**
     * @notice Set the CCTP Hook Router address
     * @param _hookRouter Address of the CCTPHookRouter contract
     */
    function setHookRouter(address _hookRouter) external;

    /**
     * @notice Set the default finality threshold for outbound CCTP burns
     * @param _threshold Finality threshold (FAST=1000 or STANDARD=2000)
     */
    function setDefaultFinalityThreshold(uint32 _threshold) external;

    // Note: View functions (merkleRoot, treeNumber, nullifiers, rootHistory, remotePools)
    // are implemented via public storage variables in PrivacyPoolStorage
}

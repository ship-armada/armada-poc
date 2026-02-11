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

    /// @notice Emitted when testing mode is changed
    event TestingModeSet(bool enabled);

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
     * @param destinationCaller Address allowed to call receiveMessage on Client (bytes32).
     *        Use bytes32(0) to allow any relayer, or specify a relayer address for MEV protection.
     * @param maxFee Maximum CCTP relayer fee in USDC raw units (deducted from burn amount at protocol level, 0 = no fee)
     * @return nonce CCTP message nonce
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
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
     * @notice Enable or disable testing mode
     * @dev POC ONLY - bypasses SNARK verification
     * @param enabled Whether to enable testing mode
     */
    function setTestingMode(bool enabled) external;

    // Note: View functions (merkleRoot, treeNumber, nullifiers, rootHistory, remotePools)
    // are implemented via public storage variables in PrivacyPoolStorage
}

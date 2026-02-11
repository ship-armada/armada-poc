// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../railgun/logic/Globals.sol";
import "../types/CCTPTypes.sol";

/**
 * @title ITransactModule
 * @notice Interface for the TransactModule - handles transact and unshield operations
 * @dev Called via delegatecall from PrivacyPool router
 */
interface ITransactModule {
    /**
     * @notice Emitted when a private transaction is processed
     * @param treeNumber The merkle tree number
     * @param startPosition Starting leaf index for new commitments
     * @param hash Array of commitment hashes
     * @param ciphertext Encrypted data for recipients
     */
    event Transact(
        uint256 treeNumber,
        uint256 startPosition,
        bytes32[] hash,
        CommitmentCiphertext[] ciphertext
    );

    /**
     * @notice Emitted when tokens are unshielded from the privacy pool
     * @param to Recipient address
     * @param token Token data
     * @param amount Amount unshielded (after fees)
     * @param fee Fee charged
     */
    event Unshield(address to, TokenData token, uint256 amount, uint256 fee);

    /**
     * @notice Emitted when nullifiers are spent
     * @param treeNumber The merkle tree number
     * @param nullifier Array of spent nullifiers
     */
    event Nullified(uint16 treeNumber, bytes32[] nullifier);

    /**
     * @notice Emitted when an atomic cross-chain unshield is initiated
     * @param destinationDomain CCTP domain of destination chain
     * @param recipient Final recipient address on destination chain
     * @param amount Amount being unshielded (after fees)
     * @param nonce CCTP message nonce
     */
    event CrossChainUnshieldInitiated(
        uint32 indexed destinationDomain,
        address indexed recipient,
        uint256 amount,
        uint64 nonce
    );

    /**
     * @notice Execute private transactions (transfers and/or local unshields)
     * @dev Validates proofs, nullifies inputs, creates new commitments
     *      For local unshields, transfers tokens to recipient
     *
     * @param _transactions Array of transactions to process
     */
    function transact(Transaction[] calldata _transactions) external;

    /**
     * @notice Atomic cross-chain unshield
     * @dev Validates proof on Hub, nullifies inputs, then burns via CCTP to Client.
     *      Client will receive CCTP message and forward USDC to finalRecipient.
     *
     * @param _transaction Transaction with unshield proof
     * @param destinationDomain Client chain's CCTP domain
     * @param finalRecipient Address to receive USDC on client chain
     * @param destinationCaller Address allowed to call receiveMessage on Client (bytes32).
     *        Use bytes32(0) to allow any relayer, or specify a relayer address for MEV protection.
     * @param maxFee Maximum CCTP relayer fee in USDC raw units (deducted from burn amount at protocol level, 0 = no fee)
     * @return nonce CCTP message nonce for tracking
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient,
        bytes32 destinationCaller,
        uint256 maxFee
    ) external returns (uint64 nonce);
}

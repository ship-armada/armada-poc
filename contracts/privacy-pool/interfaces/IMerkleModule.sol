// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title IMerkleModule
 * @notice Interface for the MerkleModule - handles merkle tree operations
 * @dev Called via delegatecall from PrivacyPool router
 */
interface IMerkleModule {
    /**
     * @notice Initialize the merkle tree with zero values
     * @dev Must be called once during PrivacyPool initialization
     */
    function initializeMerkle() external;

    /**
     * @notice Hash two values together using Poseidon
     * @param _left Left side of hash
     * @param _right Right side of hash
     * @return Poseidon hash of the two values
     */
    function hashLeftRight(bytes32 _left, bytes32 _right) external pure returns (bytes32);

    /**
     * @notice Insert leaves into the merkle tree
     * @dev Updates the merkle root and root history
     *      Creates a new tree if current one is full
     * @param _leafHashes Array of leaf hashes to insert
     */
    function insertLeaves(bytes32[] memory _leafHashes) external;

    /**
     * @notice Get the tree number and starting index for new commitments
     * @param _newCommitments Number of commitments to be inserted
     * @return treeNum Tree number where commitments will be inserted
     * @return startIndex Starting leaf index within that tree
     */
    function getInsertionTreeNumberAndStartingIndex(
        uint256 _newCommitments
    ) external view returns (uint256 treeNum, uint256 startIndex);
}

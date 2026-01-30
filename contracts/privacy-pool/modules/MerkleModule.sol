// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IMerkleModule.sol";
import "../../railgun/logic/Poseidon.sol";

/**
 * @title MerkleModule
 * @notice Handles merkle tree operations for the privacy pool
 * @dev Called via delegatecall from PrivacyPool router.
 *      Based on Railgun's Commitments.sol implementation.
 *
 *      This module manages a batch incremental merkle tree:
 *      - 16 levels deep (65,536 leaves per tree)
 *      - Uses Poseidon hash function
 *      - Supports tree rollover when full
 *      - Maintains root history for proof validation
 */
contract MerkleModule is PrivacyPoolStorage, IMerkleModule {
    /**
     * @notice Initialize the merkle tree with zero values
     * @dev Must be called once during PrivacyPool initialization.
     *      Calculates the zero values for each level and sets the initial root.
     */
    function initializeMerkle() external override {
        // Calculate zero values for each level
        // zeros[0] = H("Railgun") % SNARK_SCALAR_FIELD
        // zeros[i] = H(zeros[i-1], zeros[i-1])
        zeros[0] = ZERO_VALUE;
        bytes32 currentZero = ZERO_VALUE;

        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            // Store zero value for this level
            zeros[i] = currentZero;

            // Initialize filledSubTrees to avoid storage allocation costs later
            filledSubTrees[i] = currentZero;

            // Calculate zero value for next level
            currentZero = hashLeftRight(currentZero, currentZero);
        }

        // Set initial merkle root (root of empty tree)
        // Also cache it for quick tree rollover
        newTreeRoot = currentZero;
        merkleRoot = currentZero;
        rootHistory[treeNumber][currentZero] = true;
    }

    /**
     * @notice Hash two values together using Poseidon
     * @param _left Left side of hash
     * @param _right Right side of hash
     * @return Poseidon hash of the two values
     */
    function hashLeftRight(bytes32 _left, bytes32 _right) public pure override returns (bytes32) {
        return PoseidonT3.poseidon([_left, _right]);
    }

    /**
     * @notice Insert leaves into the merkle tree
     * @dev Updates the merkle root and root history.
     *      Creates a new tree if current one is full.
     *
     *      IMPORTANT: This function INTENTIONALLY causes side effects on the
     *      _leafHashes array to save gas. The array should not be reused after calling.
     *
     * @param _leafHashes Array of leaf hashes to insert
     */
    function insertLeaves(bytes32[] memory _leafHashes) external override {
        // Get initial count
        uint256 count = _leafHashes.length;

        // No-op if no leaves
        if (count == 0) {
            return;
        }

        // Create new tree if current one can't contain new leaves
        // We insert all commitments into a new tree to ensure they can be spent in the same tx
        if ((nextLeafIndex + count) > (2 ** TREE_DEPTH)) {
            _newTree();
        }

        // Current index is the index at each level to insert the hash
        uint256 levelInsertionIndex = nextLeafIndex;

        // Update nextLeafIndex
        nextLeafIndex += count;

        // Variables for starting point at next tree level
        uint256 nextLevelHashIndex;
        uint256 nextLevelStartIndex;

        // Loop through each level of the merkle tree and update
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            // Calculate the index to start at for the next level
            // >> is equivalent to / 2 rounded down
            nextLevelStartIndex = levelInsertionIndex >> 1;

            uint256 insertionElement = 0;

            // If we're on the right (odd index), hash with left sibling and move to left
            if (levelInsertionIndex % 2 == 1) {
                // Calculate index to insert hash into _leafHashes[]
                nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;

                // Hash with the filled subtree on the left
                _leafHashes[nextLevelHashIndex] = hashLeftRight(
                    filledSubTrees[level],
                    _leafHashes[insertionElement]
                );

                // Increment
                insertionElement += 1;
                levelInsertionIndex += 1;
            }

            // We're now on the left side, process pairs
            for (; insertionElement < count; insertionElement += 2) {
                bytes32 right;

                // Calculate right value
                if (insertionElement < count - 1) {
                    // Use the next element
                    right = _leafHashes[insertionElement + 1];
                } else {
                    // Use zero value for this level
                    right = zeros[level];
                }

                // If we've created a new subtree at this level, update filledSubTrees
                if (insertionElement == count - 1 || insertionElement == count - 2) {
                    filledSubTrees[level] = _leafHashes[insertionElement];
                }

                // Calculate index to insert hash into _leafHashes[]
                nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;

                // Calculate the hash for the next level
                _leafHashes[nextLevelHashIndex] = hashLeftRight(_leafHashes[insertionElement], right);

                // Increment level insertion index
                levelInsertionIndex += 2;
            }

            // Get starting levelInsertionIndex value for next level
            levelInsertionIndex = nextLevelStartIndex;

            // Get count of elements for next level
            count = nextLevelHashIndex + 1;
        }

        // Update the merkle root
        merkleRoot = _leafHashes[0];
        rootHistory[treeNumber][merkleRoot] = true;
    }

    /**
     * @notice Get the tree number and starting index for new commitments
     * @param _newCommitments Number of commitments to be inserted
     * @return treeNum Tree number where commitments will be inserted
     * @return startIndex Starting leaf index within that tree
     */
    function getInsertionTreeNumberAndStartingIndex(
        uint256 _newCommitments
    ) external view override returns (uint256 treeNum, uint256 startIndex) {
        // New tree will be created if current one can't contain new leaves
        if ((nextLeafIndex + _newCommitments) > (2 ** TREE_DEPTH)) {
            return (treeNumber + 1, 0);
        }

        // Else return current state
        return (treeNumber, nextLeafIndex);
    }

    /**
     * @notice Create a new merkle tree
     * @dev Called when current tree is full. Resets to empty tree state.
     */
    function _newTree() internal {
        // Restore merkleRoot to the cached empty tree root
        merkleRoot = newTreeRoot;

        // Reset next leaf index to 0
        nextLeafIndex = 0;

        // Increment tree number
        treeNumber += 1;

        // Note: filledSubTrees values from old tree will never be used,
        // so we don't need to reset them (saves gas)
    }
}

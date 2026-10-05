// SPDX-License-Identifier: MIT
// ABOUTME: Incremental Poseidon Merkle tree module for the privacy pool.
// ABOUTME: Executes exclusively via delegatecall from the PrivacyPool router, so all
// ABOUTME: tree state lives in the router's storage (see PrivacyPoolStorage).
pragma solidity ^0.8.17;

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IMerkleModule.sol";
import "../types/PoseidonLibs.sol";

/// @title MerkleModule
/// @notice Append-only incremental binary Merkle tree over Poseidon (behavior spec section 6).
/// @dev Trees are 16 levels deep (65,536 leaves). A batch of leaves always lands in a
///      single tree: when a batch would overflow the current tree, the module rolls over
///      to a fresh tree whose root is pre-cached at initialization. Every post-insertion
///      root is recorded in `rootHistory` and never removed, so historical roots remain
///      usable for proofs indefinitely.
contract MerkleModule is PrivacyPoolStorage, IMerkleModule {
    /// @notice Seeds the per-level zero nodes and the empty-tree root.
    /// @dev Runs exactly once, from `PrivacyPool.initialize`. The level-0 zero leaf is the
    ///      pinned consensus constant `ZERO_VALUE`; each subsequent level's zero node is the
    ///      Poseidon node hash of the previous level's zero node paired with itself. The
    ///      right-sibling cache (`filledSubTrees`) starts at the zero node for every level,
    ///      and the resulting root of the fully empty tree is recorded as a valid root of
    ///      tree 0 and cached for later rollovers.
    function initializeMerkle() external override onlyDelegatecall {
        bytes32 currentZero = ZERO_VALUE;

        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            zeros[level] = currentZero;
            filledSubTrees[level] = currentZero;
            currentZero = hashLeftRight(currentZero, currentZero);
        }

        newTreeRoot = currentZero;
        merkleRoot = currentZero;
        rootHistory[treeNumber][currentZero] = true;
    }

    /// @notice Poseidon node hash of two children.
    /// @param left Left child node.
    /// @param right Right child node.
    /// @return Parent node digest.
    function hashLeftRight(bytes32 left, bytes32 right) public pure override returns (bytes32) {
        return PoseidonT3.poseidon([left, right]);
    }

    /// @notice Appends a batch of leaves to the current tree and publishes the new root.
    /// @dev The batch is folded level by level, hashing pairs into the FRONT of the input
    ///      array. This deliberately mutates `leafHashes` in place to save gas — callers
    ///      MUST NOT reuse the array afterwards. At each level, `filledSubTrees` tracks the
    ///      rightmost incomplete node so a later batch can resume hashing against it.
    /// @param leafHashes Leaf digests to append.
    function insertLeaves(bytes32[] memory leafHashes) external override onlyDelegatecall {
        uint256 count = leafHashes.length;

        // Empty batch: no state change, no root-history write.
        if (count == 0) {
            return;
        }

        // Rollover: only when the batch cannot fit (an exactly-full tree does NOT roll
        // over). The whole batch then lands in the new tree at index 0. `filledSubTrees`
        // is intentionally NOT cleared: a fresh tree's insertion path never reads stale
        // left-sibling entries, so resetting them would only waste gas.
        if (nextLeafIndex + count > 2 ** TREE_DEPTH) {
            merkleRoot = newTreeRoot;
            nextLeafIndex = 0;
            treeNumber += 1;
        }

        uint256 levelInsertionIndex = nextLeafIndex;
        nextLeafIndex += count;

        uint256 nextLevelHashIndex;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            uint256 nextLevelStartIndex = levelInsertionIndex >> 1;
            uint256 pending = 0;

            // Odd insertion index: the first pending element already has a left sibling
            // from a previously completed subtree. Absorb that pair first so the pairwise
            // loop below always starts on an even (left-side) boundary.
            if (levelInsertionIndex % 2 == 1) {
                nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;
                leafHashes[nextLevelHashIndex] = hashLeftRight(filledSubTrees[level], leafHashes[pending]);
                pending = 1;
                levelInsertionIndex += 1;
            }

            // Fold the remaining pending elements pairwise into the front of the array.
            for (; pending < count; pending += 2) {
                bytes32 right;
                if (pending < count - 1) {
                    // Pair with the next pending element.
                    right = leafHashes[pending + 1];
                } else {
                    // No sibling remains: pair with this level's zero node.
                    right = zeros[level];
                }

                // The last and second-to-last pending elements are the frontier of the
                // tree at this level; remember the current one as the right sibling for
                // the next batch.
                if (pending == count - 1 || pending == count - 2) {
                    filledSubTrees[level] = leafHashes[pending];
                }

                nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;
                leafHashes[nextLevelHashIndex] = hashLeftRight(leafHashes[pending], right);
                levelInsertionIndex += 2;
            }

            // Carry the folded elements up: they become the pending set one level higher.
            levelInsertionIndex = nextLevelStartIndex;
            count = nextLevelHashIndex + 1;
        }

        // After the final level, slot 0 holds the new root.
        merkleRoot = leafHashes[0];
        rootHistory[treeNumber][merkleRoot] = true;
    }

    /// @notice Predicts where a future batch would be inserted.
    /// @dev Reachable only via delegatecall, which the router never performs for this
    ///      function (the router serves its own rollover-ignoring view); retained because
    ///      it is part of the deployed module surface. See spec OQ-1.
    /// @param newCommitments Size of the hypothetical batch.
    /// @return treeNum Tree the batch would land in.
    /// @return startIndex First leaf index the batch would occupy.
    function getInsertionTreeNumberAndStartingIndex(
        uint256 newCommitments
    ) external view override onlyDelegatecall returns (uint256 treeNum, uint256 startIndex) {
        if (nextLeafIndex + newCommitments > 2 ** TREE_DEPTH) {
            return (treeNumber + 1, 0);
        }
        return (treeNumber, nextLeafIndex);
    }
}

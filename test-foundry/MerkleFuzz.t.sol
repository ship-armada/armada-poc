// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

/// @title MerkleFuzzTest — Fuzz tests for merkle tree insertion algorithm
/// @dev Uses keccak256 as a stand-in for Poseidon to test the insertion logic
///      in isolation. The actual MerkleModule uses Poseidon which requires
///      deployed library bytecode — tested separately in integration tests.
contract MerkleFuzzTest is Test {
    uint256 constant TREE_DEPTH = 16;
    uint256 constant MAX_LEAVES = 2 ** TREE_DEPTH; // 65536

    // Simplified merkle tree state
    bytes32 public merkleRoot;
    uint256 public nextLeafIndex;
    uint256 public treeNumber;
    bytes32[16] public zeros;
    bytes32[16] internal filledSubTrees;
    mapping(uint256 => mapping(bytes32 => bool)) public rootHistory;

    function setUp() public {
        // Initialize zero values (using keccak256 instead of Poseidon)
        bytes32 currentZero = keccak256("Railgun");
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            filledSubTrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        merkleRoot = currentZero;
        rootHistory[0][merkleRoot] = true;
    }

    function _hashLeftRight(bytes32 _left, bytes32 _right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_left, _right));
    }

    /// @dev Simplified insertLeaves (mirrors MerkleModule logic with keccak256)
    function _insertLeaves(bytes32[] memory _leafHashes) internal {
        uint256 count = _leafHashes.length;
        if (count == 0) return;

        if ((nextLeafIndex + count) > MAX_LEAVES) {
            _newTree();
        }

        uint256 levelInsertionIndex = nextLeafIndex;
        nextLeafIndex += count;

        uint256 nextLevelHashIndex;
        uint256 nextLevelStartIndex;

        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            nextLevelStartIndex = levelInsertionIndex >> 1;
            uint256 insertionElement = 0;

            if (levelInsertionIndex % 2 == 1) {
                nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;
                _leafHashes[nextLevelHashIndex] = _hashLeftRight(
                    filledSubTrees[level],
                    _leafHashes[insertionElement]
                );
                insertionElement += 1;
                levelInsertionIndex += 1;
            }

            for (; insertionElement < count; insertionElement += 2) {
                bytes32 right;
                if (insertionElement < count - 1) {
                    right = _leafHashes[insertionElement + 1];
                } else {
                    right = zeros[level];
                }

                if (insertionElement == count - 1 || insertionElement == count - 2) {
                    filledSubTrees[level] = _leafHashes[insertionElement];
                }

                nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;
                _leafHashes[nextLevelHashIndex] = _hashLeftRight(_leafHashes[insertionElement], right);
                levelInsertionIndex += 2;
            }

            levelInsertionIndex = nextLevelStartIndex;
            count = nextLevelHashIndex + 1;
        }

        merkleRoot = _leafHashes[0];
        rootHistory[treeNumber][merkleRoot] = true;
    }

    function _newTree() internal {
        // Recalculate empty tree root
        bytes32 currentZero = keccak256("Railgun");
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            filledSubTrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        merkleRoot = currentZero;
        nextLeafIndex = 0;
        treeNumber += 1;
        rootHistory[treeNumber][merkleRoot] = true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Single insertion always changes the root (when leaf != zero value)
    function testFuzz_singleInsertionChangesRoot(bytes32 leaf) public {
        // Exclude zero leaf and any of the precomputed zero values at each level.
        // Inserting a zero value at position 0 produces the same root by design.
        vm.assume(leaf != bytes32(0));
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            vm.assume(leaf != zeros[i]);
        }
        bytes32 rootBefore = merkleRoot;

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = leaf;
        _insertLeaves(leaves);

        assertNotEq(merkleRoot, rootBefore, "Root should change after insertion");
    }

    /// @notice nextLeafIndex increments by count after insertion
    function testFuzz_nextLeafIndexIncrementsCorrectly(uint8 count) public {
        count = uint8(bound(count, 1, 64)); // keep reasonable

        uint256 indexBefore = nextLeafIndex;

        bytes32[] memory leaves = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            leaves[i] = keccak256(abi.encode(i, block.timestamp));
        }
        _insertLeaves(leaves);

        assertEq(nextLeafIndex, indexBefore + count, "nextLeafIndex should increment by count");
    }

    /// @notice Different insertion order produces different roots
    function testFuzz_insertionOrderMatters(bytes32 leafA, bytes32 leafB) public {
        vm.assume(leafA != leafB);

        // Insert A then B
        bytes32[] memory leavesAB = new bytes32[](2);
        leavesAB[0] = leafA;
        leavesAB[1] = leafB;
        _insertLeaves(leavesAB);
        bytes32 rootAB = merkleRoot;

        // Reset tree
        _newTree();

        // Insert B then A
        bytes32[] memory leavesBA = new bytes32[](2);
        leavesBA[0] = leafB;
        leavesBA[1] = leafA;
        _insertLeaves(leavesBA);
        bytes32 rootBA = merkleRoot;

        assertNotEq(rootAB, rootBA, "Different order should produce different roots");
    }

    /// @notice Root is always in rootHistory after insertion
    function testFuzz_rootAlwaysInHistory(bytes32 leaf) public {
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = leaf;
        _insertLeaves(leaves);

        assertTrue(rootHistory[treeNumber][merkleRoot], "New root should be in history");
    }

    /// @notice Multiple insertions each produce a root preserved in history
    function testFuzz_multipleInsertionsPreserveHistory(bytes32 leaf1, bytes32 leaf2) public {
        bytes32[] memory l1 = new bytes32[](1);
        l1[0] = leaf1;
        _insertLeaves(l1);
        bytes32 root1 = merkleRoot;

        bytes32[] memory l2 = new bytes32[](1);
        l2[0] = leaf2;
        _insertLeaves(l2);
        bytes32 root2 = merkleRoot;

        // Both roots should be in history (critical for proof validation)
        assertTrue(rootHistory[treeNumber][root1], "First root should still be in history");
        assertTrue(rootHistory[treeNumber][root2], "Second root should be in history");
    }
}

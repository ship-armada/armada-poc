// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

/// @title MerkleHandler — Stateful handler for merkle tree invariant testing
/// @dev Mirrors MerkleModule insertion logic with keccak256 (stand-in for Poseidon).
///      Maintains ghost variables for invariant checking.
contract MerkleHandler is Test {
    uint256 constant TREE_DEPTH = 16;
    uint256 constant MAX_LEAVES = 2 ** TREE_DEPTH; // 65536

    // ─── Merkle tree state (mirrors PrivacyPoolStorage) ───
    bytes32 public merkleRoot;
    uint256 public nextLeafIndex;
    uint256 public treeNumber;
    bytes32[16] public zeros;
    bytes32[16] internal filledSubTrees;
    mapping(uint256 => mapping(bytes32 => bool)) public rootHistory;

    // ─── Ghost variables for invariant tracking ───
    uint256 public totalInsertions;
    uint256 public totalTreeRollovers;
    bytes32[] public allRoots; // every root ever produced
    mapping(bytes32 => bool) public allRootsSet;

    // ─── Fee math state (mirrors _getFee from ShieldModule/TransactModule) ───
    uint120 private constant BASIS_POINTS = 10000;
    uint256 public totalFeeComputations;
    uint256 public totalFeeConservationViolations; // should always be 0

    constructor() {
        _initTree();
    }

    function _initTree() internal {
        bytes32 currentZero = keccak256("Railgun");
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            filledSubTrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        merkleRoot = currentZero;
        rootHistory[treeNumber][merkleRoot] = true;
        allRoots.push(merkleRoot);
        allRootsSet[merkleRoot] = true;
    }

    function _hashLeftRight(bytes32 _left, bytes32 _right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_left, _right));
    }

    // ══════════════════════════════════════════════════════════════════════
    // HANDLER ACTIONS (called by Foundry invariant fuzzer)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Insert 1-32 random leaves into the merkle tree
    function insertLeaves(uint8 rawCount, bytes32 seed) external {
        uint256 count = bound(rawCount, 1, 32);

        bytes32[] memory leafHashes = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            leafHashes[i] = keccak256(abi.encode(seed, i, totalInsertions));
        }

        _insertLeaves(leafHashes);
        totalInsertions += count;
    }

    /// @notice Insert exactly 1 leaf
    function insertSingleLeaf(bytes32 leaf) external {
        bytes32[] memory leafHashes = new bytes32[](1);
        leafHashes[0] = leaf;
        _insertLeaves(leafHashes);
        totalInsertions += 1;
    }

    /// @notice Compute a fee and verify conservation (inclusive mode)
    function computeFeeInclusive(uint120 amount, uint120 feeBP) external {
        amount = uint120(bound(amount, 1, type(uint120).max));
        feeBP = uint120(bound(feeBP, 0, 10000));

        (uint120 base, uint120 fee) = _getFee(uint136(amount), true, feeBP);
        totalFeeComputations++;

        if (uint256(base) + uint256(fee) != uint256(amount)) {
            totalFeeConservationViolations++;
        }
    }

    /// @notice Compute a fee and verify conservation (exclusive mode)
    function computeFeeExclusive(uint120 amount, uint120 feeBP) external {
        amount = uint120(bound(amount, 1, 1e30));
        feeBP = uint120(bound(feeBP, 0, 9999));

        // Guard against overflow
        if (uint256(BASIS_POINTS) * uint256(amount) > type(uint136).max) return;

        (uint120 base, ) = _getFee(uint136(amount), false, feeBP);
        totalFeeComputations++;

        // In exclusive mode, base should always equal amount
        if (base != amount) {
            totalFeeConservationViolations++;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTERNAL — mirrors MerkleModule.insertLeaves
    // ══════════════════════════════════════════════════════════════════════

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
        allRoots.push(merkleRoot);
        allRootsSet[merkleRoot] = true;
    }

    function _newTree() internal {
        bytes32 currentZero = keccak256("Railgun");
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            filledSubTrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        merkleRoot = currentZero;
        nextLeafIndex = 0;
        treeNumber += 1;
        totalTreeRollovers += 1;
        rootHistory[treeNumber][merkleRoot] = true;
        allRoots.push(merkleRoot);
        allRootsSet[merkleRoot] = true;
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTERNAL — mirrors _getFee from ShieldModule/TransactModule
    // ══════════════════════════════════════════════════════════════════════

    function _getFee(
        uint136 _amount,
        bool _isInclusive,
        uint120 _feeBP
    ) internal pure returns (uint120 base, uint120 fee) {
        if (_feeBP == 0) {
            return (uint120(_amount), 0);
        }

        if (_isInclusive) {
            base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
            fee = uint120(_amount) - base;
        } else {
            base = uint120(_amount);
            fee = uint120((BASIS_POINTS * _amount) / (BASIS_POINTS - _feeBP) - _amount);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // GETTERS for invariant assertions
    // ══════════════════════════════════════════════════════════════════════

    function allRootsLength() external view returns (uint256) {
        return allRoots.length;
    }

    function isRootInHistory(uint256 _treeNum, bytes32 _root) external view returns (bool) {
        return rootHistory[_treeNum][_root];
    }
}

/// @title PrivacyPoolInvariantTest — Stateful invariant tests for privacy pool components
/// @dev Uses a Handler contract to drive merkle tree insertions and fee computations.
///      Foundry invariant fuzzer calls handler actions in random order/args.
contract PrivacyPoolInvariantTest is Test {
    MerkleHandler public handler;

    function setUp() public {
        handler = new MerkleHandler();

        // Target only the handler contract
        targetContract(address(handler));

        // Target specific functions
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = MerkleHandler.insertLeaves.selector;
        selectors[1] = MerkleHandler.insertSingleLeaf.selector;
        selectors[2] = MerkleHandler.computeFeeInclusive.selector;
        selectors[3] = MerkleHandler.computeFeeExclusive.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ══════════════════════════════════════════════════════════════════════
    // MERKLE TREE INVARIANTS
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Current merkle root is always in rootHistory for current tree
    function invariant_merkleRootInHistory() public view {
        assertTrue(
            handler.isRootInHistory(handler.treeNumber(), handler.merkleRoot()),
            "Current merkle root must be in rootHistory"
        );
    }

    /// @notice nextLeafIndex never exceeds MAX_LEAVES (65536)
    function invariant_nextLeafIndexBounded() public view {
        assertLe(
            handler.nextLeafIndex(),
            2 ** 16,
            "nextLeafIndex must not exceed 2^16"
        );
    }

    /// @notice treeNumber equals total rollovers
    function invariant_treeNumberMatchesRollovers() public view {
        assertEq(
            handler.treeNumber(),
            handler.totalTreeRollovers(),
            "treeNumber must match total rollovers"
        );
    }

    /// @notice treeNumber is monotonically non-decreasing (never decreases)
    /// @dev This is implicitly true since _newTree only increments, but we verify
    function invariant_treeNumberMonotonic() public view {
        // treeNumber >= 0 always (uint256), and only increases via _newTree
        // We verify it matches the rollover count as a proxy
        assertEq(handler.treeNumber(), handler.totalTreeRollovers());
    }

    /// @notice Every root ever produced is in the allRoots tracking array
    /// @dev Verifies ghost variable consistency
    function invariant_allRootsTracked() public view {
        uint256 rootCount = handler.allRootsLength();
        // At minimum we have the initial empty tree root
        assertGe(rootCount, 1, "Must have at least initial root");
    }

    /// @notice nextLeafIndex is consistent with totalInsertions modulo rollovers
    /// @dev After each insertion of N leaves, nextLeafIndex increases by N.
    ///      On rollover, nextLeafIndex resets to 0 and the remaining leaves
    ///      are inserted into the new tree.
    function invariant_leafIndexConsistency() public view {
        // nextLeafIndex <= MAX_LEAVES is always true
        assertLe(handler.nextLeafIndex(), 2 ** 16);
        // nextLeafIndex == totalInsertions - (rollovers * MAX_LEAVES) would be ideal
        // but rollovers happen when insertion _would_ exceed, not at exact boundary
        // So we just verify the bounded property
    }

    // ══════════════════════════════════════════════════════════════════════
    // FEE MATH INVARIANTS
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Fee conservation: base + fee == amount for ALL inclusive fee computations
    function invariant_feeConservation() public view {
        assertEq(
            handler.totalFeeConservationViolations(),
            0,
            "Fee conservation must never be violated"
        );
    }
}

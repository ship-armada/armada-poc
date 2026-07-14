// ABOUTME: Regression guard for the tree-rollover event position — the router's
// ABOUTME: getInsertionTreeNumberAndStartingIndex must roll over at a tree boundary in sync with MerkleModule.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/storage/PrivacyPoolStorage.sol";

/// @dev Minimal harness that shares PrivacyPoolStorage's layout so we can exercise the REAL
///      MerkleModule.getInsertionTreeNumberAndStartingIndex (the rollover-aware reference version)
///      via delegatecall for an identical tree state.
contract MerkleProbe is PrivacyPoolStorage {
    function setTreeState(uint256 _treeNumber, uint256 _nextLeafIndex) external {
        treeNumber = _treeNumber;
        nextLeafIndex = _nextLeafIndex;
    }

    function callModule(address module, uint256 count) external returns (uint256 treeNum, uint256 startIndex) {
        (bool ok, bytes memory ret) = module.delegatecall(
            abi.encodeWithSignature("getInsertionTreeNumberAndStartingIndex(uint256)", count)
        );
        require(ok, "delegatecall failed");
        return abi.decode(ret, (uint256, uint256));
    }
}

/// @title RolloverDesyncPoC — guards against a router/module desync at a tree boundary.
/// @dev Modules read the insertion position via `IMerkleModule(address(this))`, which resolves to the
///      router's own `PrivacyPool.getInsertionTreeNumberAndStartingIndex`, NOT the MerkleModule
///      delegatecall copy. `insertLeaves` rolls the tree over at the 2**TREE_DEPTH boundary
///      (via `_newTree`), so the router getter must apply the same rollover — otherwise the
///      Shield/Transact event emitted for a boundary-crossing batch would report a stale (tree, index)
///      and off-chain wallets could never build a valid spend proof for those notes. These tests pin
///      the router getter to the MerkleModule reference at and away from the boundary.
contract RolloverDesyncPoC is Test {
    uint256 constant TREE_DEPTH = 16;
    uint256 constant MAX_LEAVES = 2 ** TREE_DEPTH; // 65536

    PrivacyPool pool;
    MerkleModule merkleModule;
    MerkleProbe probe;

    // Storage slots (from `forge inspect PrivacyPool storage-layout`)
    uint256 constant SLOT_NEXT_LEAF_INDEX = 14;
    uint256 constant SLOT_TREE_NUMBER = 17;

    function setUp() public {
        pool = new PrivacyPool();
        merkleModule = new MerkleModule();
        probe = new MerkleProbe();
    }

    /// @dev WHY: A batch that crosses the 2**TREE_DEPTH boundary must be reported at the next tree,
    ///      index 0 — the position where insertLeaves actually places it. Before the fix the router
    ///      ignored its argument and returned the stale pre-rollover position, desyncing the emitted
    ///      event from the real insertion and bricking those notes. This pins the router to the
    ///      rollover-aware MerkleModule reference at the boundary.
    function test_routerRollsOverAtTreeBoundary() public {
        uint256 currentTree = 3;
        uint256 nearFull = MAX_LEAVES - 1; // 65535: only one slot left in the current tree
        uint256 batch = 10; // inserting 10 leaves overflows the current tree

        // Drive the REAL router to the boundary.
        vm.store(address(pool), bytes32(SLOT_NEXT_LEAF_INDEX), bytes32(nearFull));
        vm.store(address(pool), bytes32(SLOT_TREE_NUMBER), bytes32(currentTree));
        assertEq(pool.nextLeafIndex(), nearFull, "router nextLeafIndex set");
        assertEq(pool.treeNumber(), currentTree, "router treeNumber set");

        // What the router reports (this is what gets emitted in the Shield/Transact event).
        (uint256 routerTree, uint256 routerIndex) = pool.getInsertionTreeNumberAndStartingIndex(batch);
        console2.log("router says  -> tree:", routerTree, "index:", routerIndex);

        // What the module (and the actual insertLeaves rollover) does for the same state.
        probe.setTreeState(currentTree, nearFull);
        (uint256 moduleTree, uint256 moduleIndex) = probe.callModule(address(merkleModule), batch);
        console2.log("module says  -> tree:", moduleTree, "index:", moduleIndex);

        // Router must roll over to the next tree at index 0 — where insertLeaves actually places the leaves.
        assertEq(routerTree, currentTree + 1, "router rolls to next tree");
        assertEq(routerIndex, 0, "router starts new tree at index 0");

        // Router and module now agree at the boundary — the emitted event position matches the real
        // insertion position.
        assertEq(routerTree, moduleTree, "router/module agree on tree at boundary");
        assertEq(routerIndex, moduleIndex, "router/module agree on index at boundary");
    }

    /// @dev WHY: Away from a boundary the router and module must also agree — confirming the rollover
    ///      branch only triggers on overflow and does not perturb the common case.
    function test_routerAndModuleAgreeAwayFromBoundary() public {
        uint256 currentTree = 3;
        uint256 index = 1000;
        uint256 batch = 10;

        vm.store(address(pool), bytes32(SLOT_NEXT_LEAF_INDEX), bytes32(index));
        vm.store(address(pool), bytes32(SLOT_TREE_NUMBER), bytes32(currentTree));

        (uint256 routerTree, uint256 routerIndex) = pool.getInsertionTreeNumberAndStartingIndex(batch);
        probe.setTreeState(currentTree, index);
        (uint256 moduleTree, uint256 moduleIndex) = probe.callModule(address(merkleModule), batch);

        assertEq(routerTree, moduleTree, "trees agree away from boundary");
        assertEq(routerIndex, moduleIndex, "indices agree away from boundary");
        assertEq(routerTree, currentTree, "no rollover away from boundary");
        assertEq(routerIndex, index, "index unchanged away from boundary");
    }
}

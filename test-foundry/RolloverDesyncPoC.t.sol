// ABOUTME: PoC for the tree-rollover event desync — router's getInsertionTreeNumberAndStartingIndex
// ABOUTME: drops the rollover branch, so Shield/Transact events report the wrong position at a tree boundary.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/storage/PrivacyPoolStorage.sol";

/// @dev Minimal harness that shares PrivacyPoolStorage's layout so we can exercise the REAL
///      MerkleModule.getInsertionTreeNumberAndStartingIndex (the correct, rollover-aware version)
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

/// @title RolloverDesyncPoC — proves the router and the module disagree at a tree boundary.
/// @dev The router (`PrivacyPool.getInsertionTreeNumberAndStartingIndex`, PrivacyPool.sol:444) ignores
///      its argument and always returns `(treeNumber, nextLeafIndex)`. The module version
///      (`MerkleModule.sol:166`) correctly returns `(treeNumber + 1, 0)` when the batch overflows the
///      current tree — but it is dead code, because modules call this via `IMerkleModule(address(this))`,
///      which resolves to the router's own function. `insertLeaves` DOES roll the tree over, so the
///      Shield/Transact event position emitted for a boundary-crossing batch points at the wrong tree/index,
///      and off-chain wallets can never build a valid spend proof for those notes.
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

    function test_routerAndModuleDisagreeAtTreeBoundary() public {
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

        // Router ignores the overflow and returns the stale pre-rollover position.
        assertEq(routerTree, currentTree, "router returns stale tree number");
        assertEq(routerIndex, nearFull, "router returns stale leaf index");

        // Module correctly rolls over to the next tree at index 0 — this is where insertLeaves
        // actually places the leaves.
        assertEq(moduleTree, currentTree + 1, "module rolls to next tree");
        assertEq(moduleIndex, 0, "module starts new tree at index 0");

        // The desync: the emitted event position does NOT match the real insertion position.
        assertTrue(
            routerTree != moduleTree || routerIndex != moduleIndex,
            "expected router/module disagreement at boundary"
        );
        console2.log("DESYNC CONFIRMED: boundary-crossing batch is emitted at the wrong tree/index");
    }

    /// @dev Away from a boundary, the two agree — confirming the bug is specifically the missing
    ///      rollover branch, not a general mismatch.
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
    }
}

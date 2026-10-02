// SPDX-License-Identifier: MIT
// ABOUTME: Test helper that installs the real generated Poseidon bytecode at the fixed
// ABOUTME: library link addresses pinned in foundry.toml (`libraries`). The in-tree
// ABOUTME: PoseidonT3/PoseidonT4 sources are compile-time stubs; tests that exercise real
// ABOUTME: Merkle/commitment hashing must call `_linkRealPoseidon()` before deploying the
// ABOUTME: pool or its modules.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";

abstract contract PoseidonLinker is Test {
    // Must match the addresses pinned under `libraries` in foundry.toml.
    address internal constant POSEIDON_T3_ADDR = 0x9000000000000000000000000000000000000903;
    address internal constant POSEIDON_T4_ADDR = 0x9000000000000000000000000000000000000904;

    /// @notice Deploys the generated Poseidon creation bytecode from
    ///         lib/poseidon_bytecode.json and etches the resulting runtime code at the
    ///         pinned link addresses.
    function _linkRealPoseidon() internal {
        string memory json = vm.readFile("lib/poseidon_bytecode.json");
        _deployAndEtch(vm.parseJsonBytes(json, ".PoseidonT3.bytecode"), POSEIDON_T3_ADDR);
        _deployAndEtch(vm.parseJsonBytes(json, ".PoseidonT4.bytecode"), POSEIDON_T4_ADDR);
    }

    function _deployAndEtch(bytes memory creationCode, address target) internal {
        address deployed;
        assembly {
            deployed := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        require(deployed != address(0), "PoseidonLinker: deploy failed");
        vm.etch(target, deployed.code);
    }
}

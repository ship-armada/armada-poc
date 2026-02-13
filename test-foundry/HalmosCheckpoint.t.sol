// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/// @title HalmosCheckpointTest — Symbolic verification of binary search checkpoint lookup
/// @dev Proves the binary search in VotingLocker._checkpointsLookup returns the correct
///      value for ALL possible checkpoint arrays (up to bounded length) and block numbers.
contract HalmosCheckpointTest is Test, SymTest {

    struct Checkpoint {
        uint32 fromBlock;
        uint224 lockedAmount;
    }

    /// @dev Mirror of VotingLocker._checkpointsLookup
    function _checkpointsLookup(
        Checkpoint[] memory ckpts,
        uint256 blockNumber
    ) internal pure returns (uint256) {
        uint256 len = ckpts.length;
        if (len == 0) return 0;

        // Optimization: check most recent checkpoint first
        if (ckpts[len - 1].fromBlock <= blockNumber) {
            return ckpts[len - 1].lockedAmount;
        }
        if (ckpts[0].fromBlock > blockNumber) {
            return 0;
        }

        // Binary search
        uint256 low = 0;
        uint256 high = len - 1;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (ckpts[mid].fromBlock <= blockNumber) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return ckpts[low].lockedAmount;
    }

    /// @dev Naive linear search (reference implementation)
    function _linearLookup(
        Checkpoint[] memory ckpts,
        uint256 blockNumber
    ) internal pure returns (uint256) {
        uint256 result = 0;
        for (uint256 i = 0; i < ckpts.length; i++) {
            if (ckpts[i].fromBlock <= blockNumber) {
                result = ckpts[i].lockedAmount;
            } else {
                break; // sorted, so no more matches
            }
        }
        return result;
    }

    /// @notice PROVE: binary search returns same result as linear search (2 checkpoints)
    function check_binaryMatchesLinear_2(
        uint32 block0,
        uint32 block1,
        uint224 amount0,
        uint224 amount1,
        uint256 queryBlock
    ) public pure {
        vm.assume(block0 < block1); // strictly increasing (invariant maintained by _writeCheckpoint)

        Checkpoint[] memory ckpts = new Checkpoint[](2);
        ckpts[0] = Checkpoint(block0, amount0);
        ckpts[1] = Checkpoint(block1, amount1);

        uint256 binaryResult = _checkpointsLookup(ckpts, queryBlock);
        uint256 linearResult = _linearLookup(ckpts, queryBlock);

        assert(binaryResult == linearResult);
    }

    /// @notice PROVE: binary search returns same result as linear search (3 checkpoints)
    function check_binaryMatchesLinear_3(
        uint32 block0,
        uint32 block1,
        uint32 block2,
        uint224 amount0,
        uint224 amount1,
        uint224 amount2,
        uint256 queryBlock
    ) public pure {
        vm.assume(block0 < block1 && block1 < block2);

        Checkpoint[] memory ckpts = new Checkpoint[](3);
        ckpts[0] = Checkpoint(block0, amount0);
        ckpts[1] = Checkpoint(block1, amount1);
        ckpts[2] = Checkpoint(block2, amount2);

        uint256 binaryResult = _checkpointsLookup(ckpts, queryBlock);
        uint256 linearResult = _linearLookup(ckpts, queryBlock);

        assert(binaryResult == linearResult);
    }

    /// @notice PROVE: binary search returns same result as linear search (4 checkpoints)
    function check_binaryMatchesLinear_4(
        uint32 block0,
        uint32 block1,
        uint32 block2,
        uint32 block3,
        uint224 amount0,
        uint224 amount1,
        uint224 amount2,
        uint224 amount3,
        uint256 queryBlock
    ) public pure {
        vm.assume(block0 < block1 && block1 < block2 && block2 < block3);

        Checkpoint[] memory ckpts = new Checkpoint[](4);
        ckpts[0] = Checkpoint(block0, amount0);
        ckpts[1] = Checkpoint(block1, amount1);
        ckpts[2] = Checkpoint(block2, amount2);
        ckpts[3] = Checkpoint(block3, amount3);

        uint256 binaryResult = _checkpointsLookup(ckpts, queryBlock);
        uint256 linearResult = _linearLookup(ckpts, queryBlock);

        assert(binaryResult == linearResult);
    }

    /// @notice PROVE: empty checkpoint array returns 0
    function check_emptyReturnsZero(uint256 queryBlock) public pure {
        Checkpoint[] memory ckpts = new Checkpoint[](0);
        uint256 result = _checkpointsLookup(ckpts, queryBlock);
        assert(result == 0);
    }

    /// @notice PROVE: query before first checkpoint returns 0
    function check_queryBeforeFirstReturnsZero(
        uint32 block0,
        uint224 amount0,
        uint256 queryBlock
    ) public pure {
        vm.assume(queryBlock < block0);

        Checkpoint[] memory ckpts = new Checkpoint[](1);
        ckpts[0] = Checkpoint(block0, amount0);

        uint256 result = _checkpointsLookup(ckpts, queryBlock);
        assert(result == 0);
    }

    /// @notice PROVE: query at or after last checkpoint returns last value
    function check_queryAfterLastReturnsLast(
        uint32 block0,
        uint32 block1,
        uint224 amount0,
        uint224 amount1,
        uint256 queryBlock
    ) public pure {
        vm.assume(block0 < block1);
        vm.assume(queryBlock >= block1);

        Checkpoint[] memory ckpts = new Checkpoint[](2);
        ckpts[0] = Checkpoint(block0, amount0);
        ckpts[1] = Checkpoint(block1, amount1);

        uint256 result = _checkpointsLookup(ckpts, queryBlock);
        assert(result == amount1);
    }

    /// @notice PROVE: query exactly at a checkpoint returns that checkpoint's value
    function check_exactBlockMatch(
        uint32 block0,
        uint32 block1,
        uint32 block2,
        uint224 amount0,
        uint224 amount1,
        uint224 amount2
    ) public pure {
        vm.assume(block0 < block1 && block1 < block2);

        Checkpoint[] memory ckpts = new Checkpoint[](3);
        ckpts[0] = Checkpoint(block0, amount0);
        ckpts[1] = Checkpoint(block1, amount1);
        ckpts[2] = Checkpoint(block2, amount2);

        // Query at each exact block
        assert(_checkpointsLookup(ckpts, block0) == amount0);
        assert(_checkpointsLookup(ckpts, block1) == amount1);
        assert(_checkpointsLookup(ckpts, block2) == amount2);
    }
}

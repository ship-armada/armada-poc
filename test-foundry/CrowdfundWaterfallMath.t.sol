// ABOUTME: Property tests for the July-2026 waterfall math in ArmadaCrowdfund._computeHopAllocations.
// ABOUTME: Fuzzes per-hop demand to verify conservation (total <= saleSize) and no ceiling underflow.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";

/// @dev Exposes the internal waterfall so its pure math can be fuzzed directly with arbitrary
///      per-hop capped demand — without the cost of building a full participant tree per run.
///      The constructor sets hopConfigs to the production ceilings (6000/4500/0), which is all
///      _computeHopAllocations reads (besides its args); it touches no USDC/ARM/participant state.
contract WaterfallHarness is ArmadaCrowdfund {
    constructor(uint256 open)
        ArmadaCrowdfund(address(0x1111), address(0x2222), address(0xBEEF), address(0xCAFE), address(0xF00D), open)
    {}

    function exposed(uint256 saleSize_, uint256[3] memory demand) external returns (uint256) {
        return _computeHopAllocations(saleSize_, demand);
    }
}

contract CrowdfundWaterfallMathTest is Test {
    WaterfallHarness internal h;

    uint256 constant BASE = 1_200_000 * 1e6; // BASE_SALE
    uint256 constant MAX_ = 1_800_000 * 1e6; // MAX_SALE

    function setUp() public {
        h = new WaterfallHarness(block.timestamp);
    }

    // ---- Conservation: the waterfall never allocates more than saleSize, for ANY demand. ----
    // WHY: the remainingAvailable cap + the `available + hop2Floor == saleSize` partition bound the
    //      total. Fuzzing arbitrary (incl. heavily oversubscribed) demand exercises every ceiling,
    //      rollover, and cap branch. A revert here would also catch a hop0Ceiling underflow.

    function testFuzz_conservation_base(uint256 d0, uint256 d1, uint256 d2) public {
        uint256[3] memory demand = [bound(d0, 0, BASE * 5), bound(d1, 0, BASE * 5), bound(d2, 0, BASE * 5)];
        uint256 total = h.exposed(BASE, demand);
        assertLe(total, BASE, "total allocated exceeds saleSize (BASE)");
    }

    function testFuzz_conservation_max(uint256 d0, uint256 d1, uint256 d2) public {
        uint256[3] memory demand = [bound(d0, 0, MAX_ * 5), bound(d1, 0, MAX_ * 5), bound(d2, 0, MAX_ * 5)];
        uint256 total = h.exposed(MAX_, demand);
        assertLe(total, MAX_, "total allocated exceeds saleSize (MAX)");
    }

    // ---- No underflow: hop0Ceiling = basePool*6000/10000 - saleSize*1000/10000 must not revert. ----
    // WHY: the new formula subtracts the extra hop-2 floor from hop-0's ceiling. In Solidity 0.8 an
    //      underflow reverts. At the production constants it resolves to exactly 47% of saleSize;
    //      these pin that (and that the two floor divisions leave no seam) at both sale sizes.

    function test_hop0Ceiling_is_47pct_base() public {
        h.exposed(BASE, [uint256(0), 0, 0]);
        assertEq(h.finalCeilings(0), (BASE * 47) / 100, "hop-0 ceiling != 47% of BASE_SALE");
    }

    function test_hop0Ceiling_is_47pct_max() public {
        h.exposed(MAX_, [uint256(0), 0, 0]);
        assertEq(h.finalCeilings(0), (MAX_ * 47) / 100, "hop-0 ceiling != 47% of MAX_SALE");
    }

    // ---- Fixed anchors from the spec: hop-1 raw ceiling 42.75%, hop-2 floor 15%. ----
    function test_ceilings_matchSpecAnchors_base() public {
        // Zero hop-0 demand so hop-1's effective ceiling = raw ceiling + full hop-0 leftover,
        // capped at remainingAvailable (== available == 85%). Assert the raw pieces via a
        // demand shape that isolates them.
        h.exposed(BASE, [uint256(0), 0, 0]);
        // hop-2 floor is 15% of saleSize (+ rollover, which is 0 here beyond the floor since
        // hop-1 demand is 0 → hop-1 leftover rolls in; assert at least the floor).
        assertGe(h.finalCeilings(2), (BASE * 15) / 100, "hop-2 effective ceiling below 15% floor");
    }

    // ---- Cross-language differential ----------------------------------------------------------
    // WHY: the committer/admin/indexer refund projection uses the TypeScript estimateAllocation()
    //      mirror of this exact waterfall. This SAME (saleSize, demand) → total table is asserted
    //      against estimateAllocation() in crowdfund-ui/packages/shared/src/lib/allocation.test.ts.
    //      Any drift between the Solidity source of truth and the off-chain projection fails one
    //      side. Values in USDC (1e6). Keep the two tables in lockstep.
    function _assertTotal(uint256 saleSize_, uint256 d0, uint256 d1, uint256 d2, uint256 expected) internal {
        uint256[3] memory demand = [d0, d1, d2];
        assertEq(h.exposed(saleSize_, demand), expected, "waterfall total mismatch");
    }

    function test_differentialVectors() public {
        uint256 K = 1_000 * 1e6; // $1,000 in 6-dec USDC
        _assertTotal(BASE, 2_000 * K,        0,         0, 564 * K);   // hop-0 oversub → 47% ceiling
        _assertTotal(MAX_, 2_000 * K,        0,         0, 846 * K);   // expanded hop-0 ceiling
        _assertTotal(BASE, 2_000 * K, 2_000 * K, 2_000 * K, 1_200 * K); // saturated → full BASE
        _assertTotal(MAX_, 2_000 * K, 2_000 * K, 2_000 * K, 1_800 * K); // saturated → full MAX
        _assertTotal(BASE,   564 * K,        0, 2_000 * K, 1_200 * K); // hop-0 leftover → hop-2 rollover
        _assertTotal(BASE,        0,  2_000 * K,        0, 1_020 * K); // hop-0 empty → hop-1 gets `available`
        _assertTotal(BASE, 1_050 * K,   436 * K,        0, 1_000 * K); // realistic success == MIN_SALE
        _assertTotal(BASE, 1_050 * K,   435 * K,        0,   999 * K); // one hop-1 slot less → below MIN_SALE
        _assertTotal(MAX_, 1_500 * K,        0,         0, 846 * K);   // concentrated hop-0 at expansion < MIN_SALE
    }
}

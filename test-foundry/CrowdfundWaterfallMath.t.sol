// ABOUTME: Property tests for the waterfall math in ArmadaCrowdfund._computeHopAllocations.
// ABOUTME: Fuzzes per-hop demand to verify conservation (total <= saleSize) and the priority-fill ceilings.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";

/// @dev Exposes the internal waterfall so its pure math can be fuzzed directly with arbitrary
///      per-hop capped demand — without the cost of building a full participant tree per run.
///      The constructor sets hopConfigs to the production ceilings (10000/10000/0), which is all
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

    uint256 constant BASE = 1_500_000 * 1e6; // BASE_SALE (== MAX_SALE)

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

    // WHY: BASE_SALE == MAX_SALE, so a separate MAX run would repeat the test above. Instead the
    //      sale size is fuzzed too, so conservation and the priority-fill identity are checked for
    //      any sale size the math might be given, not just the configured one.
    function testFuzz_conservation_anySaleSize(uint256 s, uint256 d0, uint256 d1, uint256 d2) public {
        s = bound(s, 1, 100_000_000 * 1e6);
        uint256[3] memory demand = [bound(d0, 0, s * 5), bound(d1, 0, s * 5), bound(d2, 0, s * 5)];
        uint256 total = h.exposed(s, demand);
        assertLe(total, s, "total allocated exceeds saleSize");
        uint256 sum = demand[0] + demand[1] + demand[2];
        assertEq(total, sum < s ? sum : s, "priority fill must allocate min(total demand, saleSize)");
    }

    // ---- Hop-0 ceiling: with no hop-2 floor and a 100% raw ceiling it is the whole sale. ----
    // WHY: hop0Ceiling = basePool*ceilingBps/10000 - saleSize*HOP2_EXTRA_FLOOR_BPS/10000 must not
    //      underflow (Solidity 0.8 reverts) and, at the production constants, resolves to exactly
    //      saleSize. These pin both, with and without hop-0 oversubscription.

    function test_hop0Ceiling_is_full_sale() public {
        h.exposed(BASE, [uint256(0), 0, 0]);
        assertEq(h.finalCeilings(0), BASE, "hop-0 ceiling != 100% of saleSize");
    }

    function test_hop0Ceiling_is_full_sale_when_oversubscribed() public {
        uint256 total = h.exposed(BASE, [BASE * 2, 0, 0]);
        assertEq(h.finalCeilings(0), BASE, "hop-0 ceiling != 100% of saleSize");
        assertEq(total, BASE, "oversubscribed hop-0 takes the whole sale");
    }

    // ---- Hop-2: no reserved floor; its effective ceiling is purely the rollover. ----
    // WHY: with HOP2_*_FLOOR_BPS = 0 hop-2 gets only what hop-0 and hop-1 leave: everything when
    //      they are empty, nothing when hop-0 fills the sale.
    function test_hop2Ceiling_is_rollover_only() public {
        h.exposed(BASE, [uint256(0), 0, 0]);
        assertEq(h.finalCeilings(2), BASE, "empty hop-0/hop-1 roll the whole sale to hop-2");

        h.exposed(BASE, [BASE, 0, 1_000 * 1e6]);
        assertEq(h.finalCeilings(2), 0, "a full hop-0 leaves hop-2 nothing (no floor)");
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
        _assertTotal(BASE, 2_000 * K,        0,         0, 1_500 * K); // hop-0 oversub → takes the whole sale
        _assertTotal(BASE, 2_000 * K, 2_000 * K, 2_000 * K, 1_500 * K); // saturated → full sale
        _assertTotal(BASE,   564 * K,        0, 2_000 * K, 1_500 * K); // hop-0 leftover → hop-2 rollover
        _assertTotal(BASE,        0,  2_000 * K,        0, 1_500 * K); // hop-0 empty → hop-1 gets the whole sale
        _assertTotal(BASE, 1_400 * K,        0,   300 * K, 1_500 * K); // hop-2 gets the $100K remainder
        _assertTotal(BASE, 1_050 * K,   436 * K,        0, 1_486 * K); // under the sale → everyone filled
        _assertTotal(BASE,   200 * K,        0,    50 * K,   250 * K); // exactly MIN_SALE
        _assertTotal(BASE,   200 * K,        0,    49 * K,   249 * K); // $1K less → below MIN_SALE
        _assertTotal(BASE,        0,         0,         0,         0); // no demand
    }
}

// ABOUTME: Property tests for the allocation math in ArmadaCrowdfund._computeHopAllocations.
// ABOUTME: Fuzzes per-hop demand to verify conservation, the $300k hop-2 reserve, rollovers, and pro-rating.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";

/// @dev Exposes the internal allocation so its pure math can be fuzzed directly with arbitrary
///      per-hop capped demand — without the cost of building a full participant tree per run.
///      _computeHopAllocations reads only its arguments and HOP2_RESERVE_USDC; it touches no
///      USDC/ARM/participant state.
contract WaterfallHarness is ArmadaCrowdfund {
    constructor(uint256 open)
        ArmadaCrowdfund(address(0x1111), address(0x2222), address(0xBEEF), address(0xCAFE), address(0xF00D), open)
    {}

    function exposed(uint256 saleSize_, uint256[3] memory demand) external returns (uint256 total, bool proRated) {
        return _computeHopAllocations(saleSize_, demand);
    }
}

contract CrowdfundWaterfallMathTest is Test {
    WaterfallHarness internal h;

    uint256 constant BASE = 1_800_000 * 1e6; // BASE_SALE (== MAX_SALE)
    uint256 constant RESERVE = 300_000 * 1e6; // HOP2_RESERVE_USDC

    function setUp() public {
        h = new WaterfallHarness(block.timestamp);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ---- Conservation: the allocation never exceeds saleSize, for ANY demand. ----
    // WHY: total allocation must equal min(total demand, saleSize) — nothing is over-allocated and,
    //      while demand remains, nothing is left unsold. Fuzzing arbitrary (incl. heavily
    //      oversubscribed) demand exercises the reserve, both rollovers and every cap branch.

    function testFuzz_conservation_base(uint256 d0, uint256 d1, uint256 d2) public {
        uint256[3] memory demand = [bound(d0, 0, BASE * 5), bound(d1, 0, BASE * 5), bound(d2, 0, BASE * 5)];
        (uint256 total, ) = h.exposed(BASE, demand);
        assertLe(total, BASE, "total allocated exceeds saleSize (BASE)");
        assertEq(total, _min(demand[0] + demand[1] + demand[2], BASE), "total must be min(demand, saleSize)");
    }

    // WHY: BASE_SALE == MAX_SALE, so a separate MAX run would repeat the test above. Instead the
    //      sale size is fuzzed too (including sizes below the reserve), so conservation holds for any
    //      sale size the math might be given, not just the configured one.
    function testFuzz_conservation_anySaleSize(uint256 s, uint256 d0, uint256 d1, uint256 d2) public {
        s = bound(s, 1, 100_000_000 * 1e6);
        uint256[3] memory demand = [bound(d0, 0, s * 5), bound(d1, 0, s * 5), bound(d2, 0, s * 5)];
        (uint256 total, ) = h.exposed(s, demand);
        assertLe(total, s, "total allocated exceeds saleSize");
        uint256 sum = demand[0] + demand[1] + demand[2];
        assertEq(total, sum < s ? sum : s, "allocation must be min(total demand, saleSize)");
    }

    // ---- Per-hop guarantees ----
    // WHY: each hop's allocation must stay within its demand; hop-2 must always receive at least
    //      min(demand, reserve) and hop-0 at least min(demand, saleSize - reserve) — the earmarks the
    //      brief guarantees — whatever the other hop demands.
    function testFuzz_earmarks_and_demand_bounds(uint256 d0, uint256 d2) public {
        uint256[3] memory demand = [bound(d0, 0, BASE * 5), uint256(0), bound(d2, 0, BASE * 5)];
        h.exposed(BASE, demand);
        uint256 a0 = h.finalCeilings(0);
        uint256 a2 = h.finalCeilings(2);
        assertLe(a0, demand[0], "hop-0 over its demand");
        assertLe(a2, demand[2], "hop-2 over its demand");
        assertGe(a2, _min(demand[2], RESERVE), "hop-2 below its reserve");
        assertGe(a0, _min(demand[0], BASE - RESERVE), "hop-0 below its earmark");
    }

    // WHY: rounding dust (and the settlement's rounding buffer) exists only when some hop is
    //      pro-rated. With two-way rollover that happens exactly when total demand exceeds saleSize.
    function testFuzz_pro_rated_iff_oversubscribed(uint256 d0, uint256 d1, uint256 d2) public {
        uint256[3] memory demand = [bound(d0, 0, BASE * 5), bound(d1, 0, BASE * 5), bound(d2, 0, BASE * 5)];
        (, bool proRated) = h.exposed(BASE, demand);
        assertEq(proRated, demand[0] + demand[1] + demand[2] > BASE, "pro-rated iff demand > saleSize");
    }

    // ---- Rollover examples ----

    // WHY: with no hop-0 demand, hop-2 takes the whole sale (its reserve plus all of hop-0's unused
    //      capacity).
    function test_hop2_takes_whole_sale_when_hop0_empty() public {
        h.exposed(BASE, [uint256(0), 0, BASE * 2]);
        assertEq(h.finalCeilings(2), BASE, "hop-2 gets the whole sale");
    }

    // WHY: unused reserve rolls back to hop-0: with $50k of hop-2 demand, oversubscribed hop-0 gets
    //      $1.75M, not just its $1.5M earmark.
    function test_unused_reserve_rolls_to_hop0() public {
        (uint256 total, bool proRated) = h.exposed(BASE, [BASE * 2, 0, 50_000 * 1e6]);
        assertEq(h.finalCeilings(2), 50_000 * 1e6, "hop-2 filled");
        assertEq(h.finalCeilings(0), 1_750_000 * 1e6, "hop-0 gets the unused reserve");
        assertEq(total, BASE);
        assertTrue(proRated);
    }

    // WHY: when both hops exceed their earmarks they split exactly at reserve / saleSize - reserve.
    function test_both_oversubscribed_split_at_earmarks() public {
        h.exposed(BASE, [BASE * 2, 0, BASE * 2]);
        assertEq(h.finalCeilings(2), RESERVE);
        assertEq(h.finalCeilings(0), BASE - RESERVE);
    }

    // WHY: below the sale size nothing is pro-rated: every hop is filled to its demand.
    function test_under_sale_size_everyone_filled() public {
        (uint256 total, bool proRated) = h.exposed(BASE, [uint256(1_000_000 * 1e6), 0, 500_000 * 1e6]);
        assertEq(h.finalCeilings(0), 1_000_000 * 1e6);
        assertEq(h.finalCeilings(2), 500_000 * 1e6);
        assertEq(total, 1_500_000 * 1e6);
        assertFalse(proRated);
    }

    // ---- Cross-language differential ----------------------------------------------------------
    // WHY: the committer/admin/indexer refund projection uses the TypeScript estimateAllocation()
    //      mirror of this exact allocation. This SAME (saleSize, demand) → total table is asserted
    //      against estimateAllocation() in crowdfund-ui/packages/shared/src/lib/allocation.test.ts.
    //      Any drift between the Solidity source of truth and the off-chain projection fails one
    //      side. Values in USDC (1e6). Keep the two tables in lockstep.
    function _assertTotal(uint256 saleSize_, uint256 d0, uint256 d1, uint256 d2, uint256 expected) internal {
        uint256[3] memory demand = [d0, d1, d2];
        (uint256 total, ) = h.exposed(saleSize_, demand);
        assertEq(total, expected, "allocation total mismatch");
    }

    function test_differentialVectors() public {
        uint256 K = 1_000 * 1e6; // $1,000 in 6-dec USDC
        _assertTotal(BASE, 2_000 * K,        0,         0, 1_800 * K); // hop-0 oversub, no hop-2 → takes the whole sale
        _assertTotal(BASE, 2_000 * K, 2_000 * K, 2_000 * K, 1_800 * K); // saturated → full sale
        _assertTotal(BASE, 2_000 * K,        0,    50 * K, 1_800 * K); // unused reserve rolls to hop-0
        _assertTotal(BASE,   564 * K,        0, 2_000 * K, 1_800 * K); // unused hop-0 rolls to hop-2
        _assertTotal(BASE,        0,  2_000 * K,        0, 1_800 * K); // hop-0 empty → hop-1 gets the whole sale
        _assertTotal(BASE, 1_200 * K,        0,   900 * K, 1_800 * K); // hop-2 gets reserve + $300k rollover
        _assertTotal(BASE, 1_050 * K,   436 * K,        0, 1_486 * K); // under the sale → everyone filled
        _assertTotal(BASE,   200 * K,        0,    50 * K,   250 * K); // exactly MIN_SALE
        _assertTotal(BASE,   200 * K,        0,    49 * K,   249 * K); // $1K less → below MIN_SALE
        _assertTotal(BASE,        0,         0,         0,         0); // no demand
    }
}

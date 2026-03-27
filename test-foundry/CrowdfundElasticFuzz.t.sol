// ABOUTME: Fuzz tests for the elastic expansion boundary at ELASTIC_TRIGGER ($1.5M).
// ABOUTME: Verifies saleSize is BASE_SALE or MAX_SALE based on cappedDemand threshold.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract CrowdfundElasticFuzzTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant BASE_SALE = 1_200_000 * 1e6;
    uint256 constant MAX_SALE  = 1_800_000 * 1e6;
    uint256 constant MIN_SALE  = 1_000_000 * 1e6;
    uint256 constant ELASTIC_TRIGGER = 1_500_000 * 1e6;
    uint256 constant HOP0_CAP = 15_000 * 1e6;
    uint256 constant HOP1_CAP = 4_000 * 1e6;
    uint256 constant HOP2_CAP = 1_000 * 1e6;
    uint256 constant MIN_COMMIT = 10 * 1e6;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);

        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);
    }

    /// @notice Deploy a fresh crowdfund with a given number of seeds
    function _deployCrowdfund(uint256 numSeeds) internal returns (ArmadaCrowdfund cf, address[] memory seeds) {
        cf = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, admin, admin, block.timestamp
        );
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();

        seeds = new address[](numSeeds);
        for (uint256 i = 0; i < numSeeds; i++) {
            seeds[i] = address(uint160(0xD000 + i));
        }
        cf.addSeeds(seeds);
        return (cf, seeds);
    }

    /// @notice Helper: commit a specific amount for a seed
    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(cf), amount);
        cf.commit(hop, amount);
        vm.stopPrank();
    }

    // ============ Deterministic Boundary Tests ============

    /// @notice 99 seeds × $15K = $1,485,000 < ELASTIC_TRIGGER → BASE_SALE
    function test_elasticExpansion_justBelow_usesBaseSale() public {
        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(99);
        for (uint256 i = 0; i < 99; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(cf.saleSize(), BASE_SALE, "Just below trigger should use BASE_SALE");
    }

    /// @notice 100 seeds × $15K = $1,500,000 = ELASTIC_TRIGGER → MAX_SALE
    function test_elasticExpansion_atExactThreshold_usesMaxSale() public {
        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(100);
        for (uint256 i = 0; i < 100; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(cf.saleSize(), MAX_SALE, "At exact trigger should use MAX_SALE");
    }

    /// @notice Over-cap commits are capped in cappedDemand calculation.
    ///         99 seeds at $15K + 1 seed at $20K (over-cap) = cappedDemand of $1,500,000
    ///         because the $20K is capped to $15K. Without the extra, 99 × $15K = $1,485K < trigger.
    ///         With 100 seeds total (one over-cap), cappedDemand = 100 × $15K = $1,500K → MAX_SALE.
    function test_elasticExpansion_overCapCommit_doesNotInflateCappedDemand() public {
        // 99 seeds × $15K = $1,485,000.
        // Add one more seed committing $20K (over the $15K cap).
        // cappedDemand should be 99 × $15K + min($20K, $15K) = $1,500,000 = trigger.
        // If over-cap inflated cappedDemand, it would be $1,505,000 — but it must not.
        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(100);
        for (uint256 i = 0; i < 99; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }
        // Last seed commits over cap — $20K exceeds $15K hop-0 cap
        _commitAs(cf, seeds[99], 0, 20_000 * 1e6);

        // totalCommitted includes the full $20K
        assertEq(cf.totalCommitted(), 99 * HOP0_CAP + 20_000 * 1e6);

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        // Assert directly on cappedDemand: must be exactly 100 × $15K, not inflated by the $20K
        assertEq(cf.cappedDemand(), 100 * HOP0_CAP, "Over-cap commit must not inflate cappedDemand");

        // cappedDemand = 100 × $15K = $1,500,000 = ELASTIC_TRIGGER → MAX_SALE
        assertEq(cf.saleSize(), MAX_SALE, "Capped demand at exact trigger should use MAX_SALE");

        // Verify that reducing to 99 seeds would have stayed below trigger
        // (this is structural — 99 × $15K = $1,485K < $1,500K)
        assertTrue(99 * HOP0_CAP < ELASTIC_TRIGGER, "99 seeds alone should be below trigger");
    }

    // ============ Fuzz Tests ============

    /// @notice Fuzz seeds-only: varying number of seeds and commit amounts
    function testFuzz_elasticExpansion_seedsOnly(uint256 numSeeds, uint256 commitPerSeed) public {
        numSeeds = bound(numSeeds, 1, 150);
        commitPerSeed = bound(commitPerSeed, MIN_COMMIT, HOP0_CAP);

        uint256 expectedCappedDemand = _min(commitPerSeed, HOP0_CAP) * numSeeds;

        // Skip runs where finalize would revert (below MIN_SALE)
        vm.assume(expectedCappedDemand >= MIN_SALE);

        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(numSeeds);
        for (uint256 i = 0; i < numSeeds; i++) {
            _commitAs(cf, seeds[i], 0, commitPerSeed);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        if (expectedCappedDemand >= ELASTIC_TRIGGER) {
            assertEq(cf.saleSize(), MAX_SALE, "Above trigger must use MAX_SALE");
        } else {
            assertEq(cf.saleSize(), BASE_SALE, "Below trigger must use BASE_SALE");
        }
    }

    /// @notice Fuzz mixed hops: seeds invite hop-1 participants, varying commits across hops.
    ///         Seeds always commit full cap to guarantee MIN_SALE is reachable; hop-1 commit
    ///         amount is fuzzed to explore the elastic trigger boundary.
    function testFuzz_elasticExpansion_mixedHops(
        uint256 numHop0,
        uint256 numHop1,
        uint256 commitH1
    ) public {
        // Need at least 67 seeds at $15K to reach MIN_SALE ($1,005,000 > $1M)
        numHop0 = bound(numHop0, 67, 120);
        numHop1 = bound(numHop1, 0, 20);
        commitH1 = bound(commitH1, MIN_COMMIT, HOP1_CAP);

        // Limit hop-1 to not exceed hop-0 count (each seed invites at most one hop-1)
        if (numHop1 > numHop0) numHop1 = numHop0;

        uint256 expectedCappedDemand =
            HOP0_CAP * numHop0 +
            _min(commitH1, HOP1_CAP) * numHop1;

        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(numHop0);

        // Seeds commit full cap at hop-0
        for (uint256 i = 0; i < numHop0; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }

        // Seeds invite hop-1 participants, who then commit
        for (uint256 i = 0; i < numHop1; i++) {
            address hop1Addr = address(uint160(0xE000 + i));
            vm.prank(seeds[i]);
            cf.invite(hop1Addr, 0);
            _commitAs(cf, hop1Addr, 1, commitH1);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        if (expectedCappedDemand >= ELASTIC_TRIGGER) {
            assertEq(cf.saleSize(), MAX_SALE, "Above trigger must use MAX_SALE");
        } else {
            assertEq(cf.saleSize(), BASE_SALE, "Below trigger must use BASE_SALE");
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

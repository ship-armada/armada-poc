// ABOUTME: Fuzz and boundary tests at ELASTIC_TRIGGER: elastic expansion is inert in this configuration.
// ABOUTME: Verifies saleSize stays BASE_SALE (= MAX_SALE = $1.8M) below, at, and above the trigger.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice BASE_SALE == MAX_SALE == ELASTIC_TRIGGER, so finalize() picks the same sale size on
///         either side of the trigger. These tests keep the trigger's boundary scenarios and pin
///         that no demand level changes the sale size (a later constant edit that re-enables
///         expansion would fail here).
contract CrowdfundElasticFuzzTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant BASE_SALE = 1_800_000 * 1e6;
    uint256 constant MAX_SALE  = 1_800_000 * 1e6;
    uint256 constant MIN_SALE  = 250_000 * 1e6;
    uint256 constant ELASTIC_TRIGGER = 1_800_000 * 1e6;
    uint256 constant HOP0_CAP = 100_000 * 1e6;
    uint256 constant HOP2_CAP = 10_000 * 1e6;
    uint256 constant MIN_COMMIT = 100 * 1e6;

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

    /// @notice Helper: commit a specific amount for a participant
    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(cf), amount);
        cf.commit(hop, amount);
        vm.stopPrank();
    }

    // ============ Configuration ============

    // WHY: expansion is inert only while all three values are equal; pin that directly.
    function test_elasticExpansion_isInert_baseEqualsMaxEqualsTrigger() public {
        (ArmadaCrowdfund cf, ) = _deployCrowdfund(0);
        assertEq(cf.BASE_SALE(), BASE_SALE);
        assertEq(cf.MAX_SALE(), MAX_SALE);
        assertEq(cf.ELASTIC_TRIGGER(), ELASTIC_TRIGGER);
        assertEq(cf.BASE_SALE(), cf.MAX_SALE(), "no expansion headroom");
    }

    // ============ Deterministic Boundary Tests ============

    /// @notice Capped demand one unit below the trigger ($1,799,999.999999) → BASE_SALE ($1.8M)
    function test_elasticExpansion_justBelow_usesBaseSale() public {
        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(18);
        for (uint256 i = 0; i < 17; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }
        _commitAs(cf, seeds[17], 0, HOP0_CAP - 1);

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(cf.saleSize(), BASE_SALE, "Just below trigger should use BASE_SALE");
    }

    /// @notice 18 seeds × $100K = $1,800,000 = ELASTIC_TRIGGER → MAX_SALE, which is also $1.8M
    function test_elasticExpansion_atExactThreshold_usesMaxSale() public {
        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(18);
        for (uint256 i = 0; i < 18; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(cf.saleSize(), MAX_SALE, "At exact trigger should use MAX_SALE");
        assertEq(cf.saleSize(), BASE_SALE, "and the sale size is unchanged");
    }

    /// @notice Over-cap commits are capped in the cappedDemand calculation.
    ///         17 seeds at $100K + 1 seed at $200K (over-cap): cappedDemand = 18 × $100K = $1.8M,
    ///         not $1.9M. The sale size stays $1.8M either way.
    function test_elasticExpansion_overCapCommit_doesNotInflateCappedDemand() public {
        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(18);
        for (uint256 i = 0; i < 17; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }
        // Last seed commits over cap — $200K exceeds the $100K hop-0 cap
        _commitAs(cf, seeds[17], 0, 200_000 * 1e6);

        // totalCommitted includes the full $200K
        assertEq(cf.totalCommitted(), 17 * HOP0_CAP + 200_000 * 1e6);

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        // Assert directly on cappedDemand: must be exactly 18 × $100K, not inflated by the $200K
        assertEq(cf.cappedDemand(), 18 * HOP0_CAP, "Over-cap commit must not inflate cappedDemand");
        assertEq(cf.saleSize(), MAX_SALE, "Capped demand at exact trigger should use MAX_SALE");
        assertEq(cf.totalAllocatedUsdc(), MAX_SALE, "over-cap excess is not allocated");
    }

    // ============ Fuzz Tests ============

    /// @notice Fuzz seeds-only: varying number of seeds and commit amounts. Up to 40 seeds
    ///         ($4M of possible demand) spans well past the trigger; the sale size never moves.
    function testFuzz_elasticExpansion_seedsOnly(uint256 numSeeds, uint256 commitPerSeed) public {
        numSeeds = bound(numSeeds, 1, 40);
        commitPerSeed = bound(commitPerSeed, MIN_COMMIT, HOP0_CAP);

        uint256 expectedCappedDemand = _min(commitPerSeed, HOP0_CAP) * numSeeds;

        // Skip runs that would enter refundMode (below MIN_SALE)
        vm.assume(expectedCappedDemand >= MIN_SALE);

        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(numSeeds);
        for (uint256 i = 0; i < numSeeds; i++) {
            _commitAs(cf, seeds[i], 0, commitPerSeed);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(cf.saleSize(), BASE_SALE, "sale size is $1.8M on either side of the trigger");
        assertEq(cf.totalAllocatedUsdc(), _min(expectedCappedDemand, BASE_SALE), "allocation = min(demand, sale)");
    }

    /// @notice Fuzz mixed tiers: known contributors (hop-0) plus launch-team $10k placements
    ///         (hop-2), with fuzzed commit amounts across both tiers.
    function testFuzz_elasticExpansion_mixedHops(
        uint256 numHop0,
        uint256 numHop2,
        uint256 commitH0,
        uint256 commitH2
    ) public {
        numHop0 = bound(numHop0, 0, 20);
        numHop2 = bound(numHop2, 0, 60);
        commitH0 = bound(commitH0, MIN_COMMIT, HOP0_CAP);
        commitH2 = bound(commitH2, MIN_COMMIT, HOP2_CAP);

        uint256 expectedCappedDemand = commitH0 * numHop0 + commitH2 * numHop2;
        vm.assume(expectedCappedDemand >= MIN_SALE);

        (ArmadaCrowdfund cf, address[] memory seeds) = _deployCrowdfund(numHop0);
        for (uint256 i = 0; i < numHop0; i++) {
            _commitAs(cf, seeds[i], 0, commitH0);
        }
        for (uint256 i = 0; i < numHop2; i++) {
            address hop2Addr = address(uint160(0xE000 + i));
            cf.launchTeamInvite(hop2Addr, 1);
            _commitAs(cf, hop2Addr, 2, commitH2);
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        assertEq(cf.saleSize(), BASE_SALE, "sale size is $1.8M on either side of the trigger");
        assertEq(cf.totalAllocatedUsdc(), _min(expectedCappedDemand, BASE_SALE), "allocation = min(demand, sale)");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

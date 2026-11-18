// ABOUTME: WARM-slot per-iteration microbenchmark for ArmadaCrowdfund.finalize()'s _iterateCappedDemand.
// ABOUTME: NOT representative of real finalize() gas — see CrowdfundFinalizeGasCold.t.sol for the cold profile.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Issue #213: per-iteration cost of _iterateCappedDemand's O(n) loop.
///         WARNING: this measures gasleft() with participant slots already WARM (written by
///         _populate in the same test transaction), so the ~2,220 gas/iteration it reports is a
///         per-iteration LOWER BOUND, not real finalize() gas. On-chain finalize() is its own tx
///         where every first-touch SLOAD is COLD (~8,200 gas/node) — this understates it ~3.6x.
///         For the real cold profile and the MAX_FINALIZE_NODES cap guard see
///         CrowdfundFinalizeGasCold.t.sol. The binding limit is the 16,777,216 (2^24, EIP-7825)
///         per-tx cap, not the block gas limit.
contract CrowdfundFinalizeGasTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_500_000 * 1e18;
    uint256 constant HOP0_CAP = 150_000 * 1e6;
    uint256 constant MIN_COMMIT = 50 * 1e6;
    uint16  constant MAX_SEEDS = 500;
    uint256 constant TEAM_WALLETS = 5;          // LAUNCH_TEAM_HOP1_BUDGET
    uint256 constant INVITES_PER_WALLET = 100;  // HOP1_MAX_INVITES
    uint256 constant LT_HOP2_BUDGET = 500;      // LAUNCH_TEAM_HOP2_BUDGET
    uint256 constant STRUCTURAL_MAX = 1505;     // 500 + 5 + 5 * 100 + 500

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);

        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);
    }

    // ---------- Sweep entry points (one per N) ----------

    function test_gas_finalize_300()  public { _profile(300); }
    function test_gas_finalize_500()  public { _profile(500); }
    function test_gas_finalize_800()  public { _profile(800); }
    function test_gas_finalize_1000() public { _profile(1000); }
    function test_gas_finalize_1500() public { _profile(1500); }
    // The structural maximum under the relaunch budgets.
    function test_gas_finalize_1505() public { _profile(STRUCTURAL_MAX); }

    // ---------- Profile harness ----------

    /// @dev Populate the crowdfund with exactly `targetN` participantNodes entries
    ///      (all committed), then warp past windowEnd and measure finalize() gas.
    ///      Layout (the relaunch budgets): seeds fill hop-0 up to MAX_SEEDS, then the
    ///      launch team places up to 5 hop-1 team wallets, each inviting up to 100 hop-2
    ///      nodes, then up to 500 launch-team hop-2 placements. Stops when
    ///      participantNodes.length == targetN.
    ///
    ///      WHY: gas-per-iteration in _iterateCappedDemand is dominated by the
    ///      participants[addr][hop] SLOAD plus the perHopCapped/globalCapped
    ///      accumulators. Hop distribution affects which hopConfigs slot is read,
    ///      but per-iteration the cost is uniform. Seeds commit at HOP0_CAP so
    ///      cappedDemand clears MIN_SALE for any N >= 2; every other node commits
    ///      MIN_COMMIT (team wallets too, refunded in full) so every node is committed.
    function _profile(uint256 targetN) internal {
        ArmadaCrowdfund cf = _deploy();
        _populate(cf, targetN);

        assertEq(cf.getParticipantCount(), targetN, "populate target mismatch");

        vm.warp(cf.windowEnd() + 1);

        uint256 gasBefore = gasleft();
        cf.finalize();
        uint256 gasUsed = gasBefore - gasleft();

        // Emit the data point. Run with `forge test --offline -vv` to see it.
        console2.log("finalize gas at N =", targetN, "->", gasUsed);
    }

    function _deploy() internal returns (ArmadaCrowdfund cf) {
        cf = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, admin, admin, block.timestamp
        );
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();
    }

    /// @dev Build the tree until participantNodes.length == targetN.
    function _populate(ArmadaCrowdfund cf, uint256 targetN) internal {
        require(targetN <= STRUCTURAL_MAX, "targetN exceeds structural max");

        uint256 seedCount = targetN <= MAX_SEEDS ? targetN : MAX_SEEDS;
        address[] memory seeds = new address[](seedCount);
        for (uint256 i = 0; i < seedCount; i++) {
            seeds[i] = address(uint160(0xD0000 + i));
        }
        cf.addSeeds(seeds);

        for (uint256 i = 0; i < seedCount; i++) {
            _commitAs(cf, seeds[i], 0, HOP0_CAP);
        }
        if (cf.getParticipantCount() >= targetN) return;

        // Hop-1 team wallets, each inviting up to 100 hop-2 nodes.
        uint256 hop2Count = 0;
        for (uint256 w = 0; w < TEAM_WALLETS; w++) {
            address team = address(uint160(0xE00000 + w));
            cf.launchTeamInvite(team, 0);
            _commitAs(cf, team, 1, MIN_COMMIT);
            if (cf.getParticipantCount() >= targetN) return;
            for (uint256 j = 0; j < INVITES_PER_WALLET; j++) {
                address a = address(uint160(0xF000000 + hop2Count));
                vm.prank(team);
                cf.invite(a, 1);
                _commitAs(cf, a, 2, MIN_COMMIT);
                hop2Count++;
                if (cf.getParticipantCount() >= targetN) return;
            }
        }

        // Launch-team hop-2 placements.
        for (uint256 i = 0; i < LT_HOP2_BUDGET; i++) {
            address a = address(uint160(0xF000000 + hop2Count));
            cf.launchTeamInvite(a, 1);
            _commitAs(cf, a, 2, MIN_COMMIT);
            hop2Count++;
            if (cf.getParticipantCount() >= targetN) return;
        }
    }

    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(cf), amount);
        cf.commit(hop, amount);
        vm.stopPrank();
    }
}

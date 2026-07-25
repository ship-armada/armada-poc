// ABOUTME: Gas profiling for ArmadaCrowdfund.finalize() at structurally-realistic participant counts.
// ABOUTME: Pins the per-iteration gas of _iterateCappedDemand and exposes the practical block-gas ceiling.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Issue #213: profile finalize() gas vs participantNodes count.
///         The loop in _iterateCappedDemand is O(n); the question is where n lands
///         relative to the 30M block gas limit.
///
///         The structural maximum participantNodes count is bounded by the invite
///         chain: MAX_SEEDS (180) + 3*MAX_SEEDS hop-1 (540) + 2*hop-1 hop-2 (1,080)
///         + launch-team direct invites (220) = 2,220. The sweep covers the
///         operational 300/500/800/1000/1500/1600 grid.
contract CrowdfundFinalizeGasTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant HOP0_CAP = 15_000 * 1e6;
    uint256 constant HOP1_CAP = 4_000 * 1e6;
    uint256 constant HOP2_CAP = 1_000 * 1e6;
    uint256 constant MIN_COMMIT = 10 * 1e6;
    uint8   constant MAX_SEEDS = 180;

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
    function test_gas_finalize_1600() public { _profile(1600); }

    // ---------- Profile harness ----------

    /// @dev Populate the crowdfund with exactly `targetN` participantNodes entries
    ///      (all committed), then warp past windowEnd and measure finalize() gas.
    ///      Layout: seeds fill hop-0 up to MAX_SEEDS, then each seed invites up to 3
    ///      hop-1 nodes, then each hop-1 invites up to 2 hop-2 nodes. Stops when
    ///      participantNodes.length == targetN.
    ///
    ///      WHY: gas-per-iteration in _iterateCappedDemand is dominated by the
    ///      participants[addr][hop] SLOAD plus the perHopCapped/globalCapped
    ///      accumulators. Hop distribution affects which hopConfigs slot is read,
    ///      but per-iteration the cost is uniform. Seeds commit at HOP0_CAP so
    ///      cappedDemand clears MIN_SALE for any N >= 67; smaller hops commit
    ///      MIN_COMMIT to minimize setup time.
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

    /// @dev Walk the invite tree depth-first until participantNodes.length == targetN.
    function _populate(ArmadaCrowdfund cf, uint256 targetN) internal {
        require(targetN <= uint256(MAX_SEEDS) * (1 + 3 + 3 * 2), "targetN exceeds structural max");

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

        // Hop-1: each seed invites up to 3.
        uint256 hop1Budget = (targetN - cf.getParticipantCount());
        address[] memory hop1Addrs = new address[](hop1Budget);
        uint256 hop1Count = 0;
        for (uint256 i = 0; i < seedCount && hop1Count < hop1Budget; i++) {
            for (uint8 j = 0; j < 3 && hop1Count < hop1Budget; j++) {
                address a = address(uint160(0xE00000 + hop1Count));
                vm.prank(seeds[i]);
                cf.invite(a, 0);
                _commitAs(cf, a, 1, MIN_COMMIT);
                hop1Addrs[hop1Count] = a;
                hop1Count++;
                if (cf.getParticipantCount() >= targetN) return;
            }
        }

        // Hop-2: each hop-1 invites up to 2.
        uint256 hop2Budget = targetN - cf.getParticipantCount();
        uint256 hop2Count = 0;
        for (uint256 i = 0; i < hop1Count && hop2Count < hop2Budget; i++) {
            for (uint8 j = 0; j < 2 && hop2Count < hop2Budget; j++) {
                address a = address(uint160(0xF000000 + hop2Count));
                vm.prank(hop1Addrs[i]);
                cf.invite(a, 1);
                _commitAs(cf, a, 2, MIN_COMMIT);
                hop2Count++;
                if (cf.getParticipantCount() >= targetN) return;
            }
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

// ABOUTME: Pins the crowdfund relaunch configuration: constants, sale outcomes, tier priority, and access.
// ABOUTME: Covers refund mode, boundaries, pro-rata and crowd-out of the $10k tier, team-wallet links, and limits.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Relaunch layout: hop 0 = known contributors ($150k cap, added by the launch team);
///         hop 1 = team-owned inviter wallets only ($0 cap, 100 invite links each); hop 2 = invited
///         and outside contributors ($10k cap, placed by the launch team or via a team-wallet link).
///         Hops fill in priority order against a single $1.5M sale size; $250k minimum.
contract CrowdfundRelaunchConfigTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    ArmadaCrowdfund public cf;

    address public treasury = address(0xCAFE);
    address public launchTeam = address(0x1A0);
    address public securityCouncil = address(0x5C0);
    address public delegatee = address(0xDE1E);

    uint256 constant USDC = 1e6;
    uint256 constant ARM = 1e18;
    uint256 constant SALE = 1_500_000 * USDC;
    uint256 constant KNOWN_CAP = 150_000 * USDC;
    uint256 constant SMALL_CAP = 10_000 * USDC;
    uint256 constant TEAM_WALLET_PK = 0xA11CE;

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(address(this), address(this));
        address[] memory wl = new address[](1);
        wl[0] = address(this);
        armToken.initWhitelist(wl);

        cf = new ArmadaCrowdfund(address(usdc), address(armToken), treasury, launchTeam, securityCouncil, block.timestamp);
        // claim() transfers ARM and delegates atomically: the crowdfund must be a whitelisted
        // sender and an authorized delegator.
        armToken.addToWhitelist(address(cf));
        address[] memory delegators = new address[](1);
        delegators[0] = address(cf);
        armToken.initAuthorizedDelegators(delegators);
        armToken.transfer(address(cf), 1_500_000 * ARM);
        cf.loadArm();
    }

    // ============ Helpers ============

    function _knownAddr(uint256 i) internal pure returns (address) { return address(uint160(0x10000000 + i)); }
    function _smallAddr(uint256 i) internal pure returns (address) { return address(uint160(0x30000000 + i)); }
    function _linkAddr(uint256 i) internal pure returns (address) { return address(uint160(0x40000000 + i)); }

    function _addKnown(uint256 count) internal {
        address[] memory seeds = new address[](count);
        for (uint256 i = 0; i < count; i++) seeds[i] = _knownAddr(i);
        vm.prank(launchTeam);
        cf.addSeeds(seeds);
    }

    function _placeSmall(uint256 count) internal {
        vm.startPrank(launchTeam);
        for (uint256 i = 0; i < count; i++) cf.launchTeamInvite(_smallAddr(i), 1);
        vm.stopPrank();
    }

    function _commit(address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(cf), amount);
        cf.commit(hop, amount);
        vm.stopPrank();
    }

    function _commitKnown(uint256 count, uint256 amount) internal {
        for (uint256 i = 0; i < count; i++) _commit(_knownAddr(i), 0, amount);
    }

    function _commitSmall(uint256 count, uint256 amount) internal {
        for (uint256 i = 0; i < count; i++) _commit(_smallAddr(i), 2, amount);
    }

    function _finalize() internal {
        vm.warp(cf.windowEnd() + 1);
        cf.finalize();
    }

    /// @dev EIP-712 invite signature, as the committer app produces for a link.
    function _signInvite(uint256 pk, uint8 fromHop, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("ArmadaCrowdfund")), keccak256(bytes("1")), block.chainid, address(cf)
        ));
        bytes32 structHash = keccak256(abi.encode(cf.INVITE_TYPEHASH(), vm.addr(pk), fromHop, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Redeem a team-wallet link (fromHop 1 → joins hop 2) and commit `amount`.
    function _redeemLink(address invitee, uint256 nonce, uint256 amount) internal {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInvite(TEAM_WALLET_PK, 1, nonce, deadline);
        usdc.mint(invitee, amount);
        vm.startPrank(invitee);
        usdc.approve(address(cf), amount);
        cf.commitWithInvite(vm.addr(TEAM_WALLET_PK), 1, nonce, deadline, sig, amount);
        vm.stopPrank();
    }

    function _armOf(address who) internal view returns (uint256 arm) {
        (arm, ) = cf.computeAllocation(who);
    }

    function _refundOf(address who) internal view returns (uint256 refund) {
        (, refund) = cf.computeAllocation(who);
    }

    // ============ Constants ============

    // WHY: pins every relaunch decision (.context decision sheet) so an accidental edit to any
    //      constant fails here rather than in production.
    function test_constants_match_relaunch_decisions() public view {
        assertEq(cf.BASE_SALE(), SALE, "BASE_SALE");
        assertEq(cf.MAX_SALE(), SALE, "MAX_SALE");
        assertEq(cf.ELASTIC_TRIGGER(), SALE, "ELASTIC_TRIGGER");
        assertEq(cf.MIN_SALE(), 250_000 * USDC, "MIN_SALE");
        assertEq(cf.ARM_PRICE(), 1 * USDC, "ARM_PRICE");
        assertEq(cf.HOP2_BASE_FLOOR_BPS(), 0, "HOP2_BASE_FLOOR_BPS");
        assertEq(cf.HOP2_EXTRA_FLOOR_BPS(), 0, "HOP2_EXTRA_FLOOR_BPS");
        assertEq(cf.HOP0_CEILING_BPS(), 10000, "HOP0_CEILING_BPS");
        assertEq(cf.HOP1_CEILING_BPS(), 10000, "HOP1_CEILING_BPS");
        assertEq(cf.HOP0_CAP_USDC(), KNOWN_CAP, "HOP0_CAP_USDC");
        assertEq(cf.HOP1_CAP_USDC(), 0, "HOP1_CAP_USDC");
        assertEq(cf.HOP2_CAP_USDC(), SMALL_CAP, "HOP2_CAP_USDC");
        assertEq(cf.HOP0_MAX_INVITES(), 0, "HOP0_MAX_INVITES");
        assertEq(cf.HOP1_MAX_INVITES(), 100, "HOP1_MAX_INVITES");
        assertEq(cf.HOP2_MAX_INVITES(), 0, "HOP2_MAX_INVITES");
        assertEq(cf.HOP0_MAX_INVITES_RECEIVED(), 1, "HOP0_MAX_INVITES_RECEIVED");
        assertEq(cf.HOP1_MAX_INVITES_RECEIVED(), 1, "HOP1_MAX_INVITES_RECEIVED");
        assertEq(cf.HOP2_MAX_INVITES_RECEIVED(), 1, "HOP2_MAX_INVITES_RECEIVED");
        assertEq(cf.MAX_SEEDS(), 500, "MAX_SEEDS");
        assertEq(cf.LAUNCH_TEAM_HOP1_BUDGET(), 5, "LAUNCH_TEAM_HOP1_BUDGET");
        assertEq(cf.LAUNCH_TEAM_HOP2_BUDGET(), 500, "LAUNCH_TEAM_HOP2_BUDGET");
        assertEq(cf.WINDOW_DURATION(), 7 days, "WINDOW_DURATION");
        assertEq(cf.MAX_WINDOW_DURATION(), 14 days, "MAX_WINDOW_DURATION");
        assertEq(cf.MIN_COMMIT(), 50 * USDC, "MIN_COMMIT");
        assertEq(cf.CLAIM_DEADLINE_DURATION(), 1095 days, "CLAIM_DEADLINE_DURATION");
        assertEq(cf.MAX_FINALIZE_NODES(), 1800, "MAX_FINALIZE_NODES");
    }

    // WHY: the sale must be pre-funded with exactly MAX_SALE / ARM_PRICE ARM (1.5M); loadArm
    //      refuses anything less, so the deploy's ARM distribution must match.
    function test_loadArm_requires_1_5M_arm() public {
        ArmadaCrowdfund fresh = new ArmadaCrowdfund(address(usdc), address(armToken), treasury, launchTeam, securityCouncil, block.timestamp);
        armToken.transfer(address(fresh), 1_500_000 * ARM - 1);
        vm.expectRevert("ArmadaCrowdfund: insufficient ARM for MAX_SALE");
        fresh.loadArm();
        armToken.transfer(address(fresh), 1);
        fresh.loadArm();
        assertTrue(fresh.armLoaded());
    }

    // WHY: the 7-day window is extendable to 14 days total, and no further.
    function test_window_is_7_days_extendable_to_14() public {
        uint256 start = cf.windowStart();
        assertEq(cf.windowEnd(), start + 7 days);
        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: exceeds max window");
        cf.extendWindow(start + 14 days + 1);
        vm.prank(launchTeam);
        cf.extendWindow(start + 14 days);
        assertEq(cf.windowEnd(), start + 14 days);
    }

    // ============ Outcomes: refund mode and the minimum ============

    // WHY: below $250k of capped demand the sale must enter refund mode and return every deposit.
    function test_refund_mode_below_minimum() public {
        _addKnown(1);
        _placeSmall(9);
        _commitKnown(1, KNOWN_CAP);
        _commitSmall(9, SMALL_CAP); // $150k + $90k = $240k
        _finalize();

        assertTrue(cf.refundMode(), "should be refund mode");
        vm.prank(_knownAddr(0));
        cf.claimRefund();
        assertEq(usdc.balanceOf(_knownAddr(0)), KNOWN_CAP);
        vm.prank(_smallAddr(0));
        cf.claimRefund();
        assertEq(usdc.balanceOf(_smallAddr(0)), SMALL_CAP);
    }

    // WHY: the minimum is inclusive: exactly $250k succeeds, and everyone is filled in full.
    function test_exactly_minimum_succeeds_in_full() public {
        _addKnown(1);
        _placeSmall(10);
        _commitKnown(1, KNOWN_CAP);
        _commitSmall(10, SMALL_CAP); // $250k
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), 250_000 * USDC);
        assertEq(_armOf(_knownAddr(0)), 150_000 * ARM);
        assertEq(_armOf(_smallAddr(0)), 10_000 * ARM);
        assertEq(_refundOf(_smallAddr(0)), 0);
    }

    // WHY: unlike the old waterfall (hop-0 ceiling below the minimum), any tier mix that commits
    //      $250k must succeed. Two known contributors alone clear it.
    function test_known_tier_alone_clears_minimum() public {
        _addKnown(2);
        _commitKnown(2, KNOWN_CAP); // $300k, hop 0 only
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(_armOf(_knownAddr(1)), 150_000 * ARM);
        assertEq(_refundOf(_knownAddr(1)), 0);
    }

    // WHY: the $10k tier alone (25 contributors) must also clear the minimum.
    function test_small_tier_alone_clears_minimum() public {
        _placeSmall(25);
        _commitSmall(25, SMALL_CAP); // $250k, hop 2 only
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(_armOf(_smallAddr(24)), 10_000 * ARM);
    }

    // ============ Outcomes: priority fill against $1.5M ============

    // WHY: exactly $1.5M fills everyone in full; pro-rating only starts above it.
    function test_exactly_sale_size_fills_in_full() public {
        _addKnown(10);
        _commitKnown(10, KNOWN_CAP); // $1.5M
        _finalize();

        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(_armOf(_knownAddr(9)), 150_000 * ARM);
        assertEq(_refundOf(_knownAddr(9)), 0);
    }

    // WHY: when known demand fits but the total doesn't, the known tier is filled and the $10k
    //      tier shares what's left pro-rata: $1.2M known + $600k small → small gets 50%.
    function test_small_tier_pro_rated_when_total_exceeds_sale() public {
        _addKnown(8);
        _placeSmall(60);
        _commitKnown(8, KNOWN_CAP);
        _commitSmall(60, SMALL_CAP);
        _finalize();

        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(_armOf(_knownAddr(0)), 150_000 * ARM, "known filled");
        assertEq(_armOf(_smallAddr(0)), 5_000 * ARM, "small at 50%");
        assertEq(_refundOf(_smallAddr(0)), 5_000 * USDC, "small refund");
    }

    // WHY: with no reserved floor, known demand at or above $1.5M takes the whole sale. The $10k
    //      tier gets no ARM and a full refund, through claim() and with no delegate needed.
    function test_small_tier_crowded_out_and_refunded_without_delegate() public {
        _addKnown(11);
        _placeSmall(5);
        _commitKnown(11, KNOWN_CAP); // $1.65M known
        _commitSmall(5, SMALL_CAP);
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), SALE);
        // Known pro-rated to $1.5M / $1.65M (floor division).
        uint256 knownAccepted = (KNOWN_CAP * SALE) / (11 * KNOWN_CAP);
        assertEq(_armOf(_knownAddr(0)), knownAccepted * 1e12, "known pro-rated");
        assertEq(_armOf(_smallAddr(0)), 0, "small gets no ARM");

        // claimRefund() is only for refund mode / cancel; a crowded-out contributor uses claim().
        vm.prank(_smallAddr(0));
        vm.expectRevert("ArmadaCrowdfund: refund not available");
        cf.claimRefund();
        vm.prank(_smallAddr(0));
        cf.claim(address(0));
        assertEq(usdc.balanceOf(_smallAddr(0)), SMALL_CAP, "full refund");
        assertEq(armToken.balanceOf(_smallAddr(0)), 0);
    }

    // ============ Team wallets (hop 1) ============

    // WHY: team wallets have a $0 cap. An accidental commit must not count towards demand,
    //      must earn no ARM, and must be fully refundable through claim() after a success.
    function test_team_wallet_commit_is_excluded_and_refunded() public {
        address team = vm.addr(TEAM_WALLET_PK);
        vm.prank(launchTeam);
        cf.launchTeamInvite(team, 0);
        _addKnown(2);
        _commitKnown(2, KNOWN_CAP);
        _commit(team, 1, 1_000 * USDC);
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(cf.cappedDemand(), 300_000 * USDC, "team commit excluded from demand");
        assertEq(cf.totalAllocatedUsdc(), 300_000 * USDC);
        assertEq(_armOf(team), 0);
        vm.prank(team);
        cf.claim(address(0));
        assertEq(usdc.balanceOf(team), 1_000 * USDC, "full refund");
    }

    // WHY: each team wallet issues exactly 100 links into the $10k tier; the 101st is rejected.
    function test_team_wallet_issues_100_links_then_stops() public {
        vm.prank(launchTeam);
        cf.launchTeamInvite(vm.addr(TEAM_WALLET_PK), 0);

        for (uint256 i = 0; i < 100; i++) _redeemLink(_linkAddr(i), i + 1, 50 * USDC);
        assertTrue(cf.isWhitelisted(_linkAddr(99), 2));
        assertEq(cf.getInvitesRemaining(vm.addr(TEAM_WALLET_PK), 1), 0);

        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInvite(TEAM_WALLET_PK, 1, 101, deadline);
        address extra = _linkAddr(100);
        usdc.mint(extra, 50 * USDC);
        vm.startPrank(extra);
        usdc.approve(address(cf), 50 * USDC);
        vm.expectRevert("ArmadaCrowdfund: invite limit reached");
        cf.commitWithInvite(vm.addr(TEAM_WALLET_PK), 1, 101, deadline, sig, 50 * USDC);
        vm.stopPrank();
    }

    // WHY: no stacking at the $10k tier: a second link redeemed by the same address reverts,
    //      and because the whole transaction reverts the second link stays unused.
    function test_second_link_to_same_address_reverts_without_using_it() public {
        vm.prank(launchTeam);
        cf.launchTeamInvite(vm.addr(TEAM_WALLET_PK), 0);
        address invitee = _linkAddr(0);
        _redeemLink(invitee, 1, 50 * USDC);

        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInvite(TEAM_WALLET_PK, 1, 2, deadline);
        usdc.mint(invitee, 50 * USDC);
        vm.startPrank(invitee);
        usdc.approve(address(cf), 50 * USDC);
        vm.expectRevert("ArmadaCrowdfund: max invites received");
        cf.commitWithInvite(vm.addr(TEAM_WALLET_PK), 1, 2, deadline, sig, 50 * USDC);
        vm.stopPrank();
        assertFalse(cf.usedNonces(vm.addr(TEAM_WALLET_PK), 2), "link not consumed");
        assertEq(cf.getEffectiveCap(invitee, 2), SMALL_CAP, "cap not stacked");
    }

    // WHY: only hop 1 (team wallets) may invite. Known contributors and $10k contributors must
    //      not be able to bring anyone in, directly or by link.
    function test_known_and_small_tiers_cannot_invite() public {
        _addKnown(1);
        _placeSmall(1);

        vm.prank(_knownAddr(0));
        vm.expectRevert("ArmadaCrowdfund: invite limit reached");
        cf.invite(address(0xBEEF), 0);

        vm.prank(_smallAddr(0));
        vm.expectRevert("ArmadaCrowdfund: max hop reached");
        cf.invite(address(0xBEEF), 2);
    }

    // ============ Limits ============

    // WHY: MAX_SEEDS (500) and LAUNCH_TEAM_HOP2_BUDGET (500) exceed uint8; both must admit
    //      exactly 500 and reject the 501st. The hop-1 budget (5) rejects the 6th placement.
    function test_launch_team_limits_at_their_boundaries() public {
        _addKnown(500);
        assertEq(cf.getParticipantCount(), 500);
        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: seed cap reached");
        cf.addSeed(_knownAddr(500));

        _placeSmall(500);
        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: hop-2 budget exhausted");
        cf.launchTeamInvite(_smallAddr(500), 1);
        (uint256 hop1Remaining, uint256 hop2Remaining) = cf.getLaunchTeamBudgetRemaining();
        assertEq(hop1Remaining, 5);
        assertEq(hop2Remaining, 0);

        vm.startPrank(launchTeam);
        for (uint256 i = 0; i < 5; i++) cf.launchTeamInvite(address(uint160(0x20000000 + i)), 0);
        vm.expectRevert("ArmadaCrowdfund: hop-1 budget exhausted");
        cf.launchTeamInvite(address(uint160(0x20000000 + 5)), 0);
        vm.stopPrank();
    }

    // WHY: the most participants this configuration allows is 1,505 (500 known + 5 team wallets
    //      + 500 direct $10k placements + 500 link redemptions), under the 1,800 limit; finalize
    //      over all of them, every one committed, must fit in the 2^24 per-transaction gas cap.
    //      (Warm-storage measurement; CrowdfundFinalizeGasCold measures the cold per-node cost.)
    function test_maximum_participants_finalize_within_gas_cap() public {
        _addKnown(500);
        _placeSmall(500);
        // Five team wallets (five keys), 100 links each.
        for (uint256 w = 0; w < 5; w++) {
            uint256 pk = TEAM_WALLET_PK + w;
            vm.prank(launchTeam);
            cf.launchTeamInvite(vm.addr(pk), 0);
            for (uint256 i = 0; i < 100; i++) {
                uint256 n = w * 100 + i;
                uint256 deadline = block.timestamp + 1 days;
                bytes memory sig = _signInvite(pk, 1, i + 1, deadline);
                address invitee = _linkAddr(n);
                usdc.mint(invitee, 50 * USDC);
                vm.startPrank(invitee);
                usdc.approve(address(cf), 50 * USDC);
                cf.commitWithInvite(vm.addr(pk), 1, i + 1, deadline, sig, 50 * USDC);
                vm.stopPrank();
            }
        }
        // Known tier at full caps: success path, with the known tier oversubscribed.
        _commitKnown(500, KNOWN_CAP);
        _commitSmall(500, 50 * USDC);
        assertEq(cf.getParticipantCount(), 1505, "maximum participants");

        vm.warp(cf.windowEnd() + 1);
        uint256 before = gasleft();
        cf.finalize();
        uint256 used = before - gasleft();
        assertLt(used, 16_777_216, "finalize must fit the per-transaction gas cap");
        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), SALE);
    }
}

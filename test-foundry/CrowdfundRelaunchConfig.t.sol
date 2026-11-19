// ABOUTME: Pins the crowdfund relaunch configuration: constants, sale outcomes, tier priority, team payment, access.
// ABOUTME: Covers refund mode, boundaries, the $300k Invited reserve and rollovers, the exact $250k payment, links, limits.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Relaunch layout: hop 0 = known contributors ($100k cap, added by the launch team);
///         hop 1 = one team-owned inviter wallet ($0 cap, 100 invite links); hop 2 = invited and
///         outside contributors ($10k per slot, up to 20 slots per address; placed by the launch
///         team or via a team-wallet link). Fixed $1.8M sale, $250k minimum. Invited gets first
///         priority for $300k, Known up to the rest, unused capacity rolls both ways. A successful
///         sale pays the launch team exactly $250k; the rest goes to the treasury.
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
    uint256 constant SALE = 1_800_000 * USDC;
    uint256 constant RESERVE = 300_000 * USDC;
    uint256 constant TEAM_PAYMENT = 250_000 * USDC;
    uint256 constant KNOWN_CAP = 100_000 * USDC;
    uint256 constant SMALL_CAP = 10_000 * USDC;
    uint256 constant TEAM_WALLET_PK = 0xA11CE;

    event LaunchTeamPaid(address indexed recipient, uint256 amount);

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
        armToken.transfer(address(cf), 1_800_000 * ARM);
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
        assertEq(cf.HOP2_RESERVE_USDC(), RESERVE, "HOP2_RESERVE_USDC");
        assertEq(cf.TEAM_PAYMENT_USDC(), TEAM_PAYMENT, "TEAM_PAYMENT_USDC");
        assertLe(cf.TEAM_PAYMENT_USDC(), cf.MIN_SALE(), "a minimum sale must cover the team payment");
        assertEq(cf.HOP0_CAP_USDC(), KNOWN_CAP, "HOP0_CAP_USDC");
        assertEq(cf.HOP1_CAP_USDC(), 0, "HOP1_CAP_USDC");
        assertEq(cf.HOP2_CAP_USDC(), SMALL_CAP, "HOP2_CAP_USDC");
        assertEq(cf.HOP0_MAX_INVITES(), 0, "HOP0_MAX_INVITES");
        assertEq(cf.HOP1_MAX_INVITES(), 100, "HOP1_MAX_INVITES");
        assertEq(cf.HOP2_MAX_INVITES(), 0, "HOP2_MAX_INVITES");
        assertEq(cf.HOP0_MAX_INVITES_RECEIVED(), 1, "HOP0_MAX_INVITES_RECEIVED");
        assertEq(cf.HOP1_MAX_INVITES_RECEIVED(), 1, "HOP1_MAX_INVITES_RECEIVED");
        assertEq(cf.HOP2_MAX_INVITES_RECEIVED(), 20, "HOP2_MAX_INVITES_RECEIVED");
        assertEq(cf.MAX_SEEDS(), 500, "MAX_SEEDS");
        assertEq(cf.LAUNCH_TEAM_HOP1_BUDGET(), 1, "LAUNCH_TEAM_HOP1_BUDGET");
        assertEq(cf.LAUNCH_TEAM_HOP2_BUDGET(), 500, "LAUNCH_TEAM_HOP2_BUDGET");
        assertEq(cf.WINDOW_DURATION(), 5 days, "WINDOW_DURATION");
        assertEq(cf.MAX_WINDOW_DURATION(), 15 days, "MAX_WINDOW_DURATION");
        assertEq(cf.MIN_COMMIT(), 100 * USDC, "MIN_COMMIT");
        assertEq(cf.CLAIM_DEADLINE_DURATION(), 1095 days, "CLAIM_DEADLINE_DURATION");
        assertEq(cf.MAX_FINALIZE_NODES(), 1800, "MAX_FINALIZE_NODES");
    }

    // WHY: the sale must be pre-funded with exactly MAX_SALE / ARM_PRICE ARM (1.8M); loadArm
    //      refuses anything less, so the deploy's ARM distribution must match.
    function test_loadArm_requires_1_8M_arm() public {
        ArmadaCrowdfund fresh = new ArmadaCrowdfund(address(usdc), address(armToken), treasury, launchTeam, securityCouncil, block.timestamp);
        armToken.transfer(address(fresh), 1_800_000 * ARM - 1);
        vm.expectRevert("ArmadaCrowdfund: insufficient ARM for MAX_SALE");
        fresh.loadArm();
        armToken.transfer(address(fresh), 1);
        fresh.loadArm();
        assertTrue(fresh.armLoaded());
    }

    // WHY: the 5-day window is extendable to 15 days total, and no further. Two +5-day extensions
    //      (the brief's ops rule) reach exactly the cap.
    function test_window_is_5_days_extendable_to_15() public {
        uint256 start = cf.windowStart();
        assertEq(cf.windowEnd(), start + 5 days);
        vm.startPrank(launchTeam);
        cf.extendWindow(start + 10 days);
        vm.expectRevert("ArmadaCrowdfund: exceeds max window");
        cf.extendWindow(start + 15 days + 1);
        cf.extendWindow(start + 15 days);
        vm.stopPrank();
        assertEq(cf.windowEnd(), start + 15 days);
    }

    // ============ Outcomes: refund mode and the minimum ============

    // WHY: below $250k of capped demand the sale must enter refund mode and return every deposit.
    function test_refund_mode_below_minimum() public {
        _addKnown(1);
        _placeSmall(14);
        _commitKnown(1, KNOWN_CAP);
        _commitSmall(14, SMALL_CAP); // $100k + $140k = $240k
        _finalize();

        assertTrue(cf.refundMode(), "should be refund mode");
        assertEq(usdc.balanceOf(launchTeam), 0, "no team payment in refund mode");
        assertEq(usdc.balanceOf(treasury), 0, "no proceeds in refund mode");
        vm.prank(_knownAddr(0));
        cf.claimRefund();
        assertEq(usdc.balanceOf(_knownAddr(0)), KNOWN_CAP);
        vm.prank(_smallAddr(0));
        cf.claimRefund();
        assertEq(usdc.balanceOf(_smallAddr(0)), SMALL_CAP);
    }

    // WHY: the minimum is inclusive: exactly $250k succeeds, everyone is filled in full, the team
    //      receives exactly $250k and the treasury nothing. No tier is pro-rated, so there is no
    //      rounding dust to hold back and the split is exact (the brief's boundary case).
    function test_exactly_minimum_succeeds_in_full_and_pays_team_exactly() public {
        _addKnown(1);
        _placeSmall(15);
        _commitKnown(1, KNOWN_CAP);
        _commitSmall(15, SMALL_CAP); // $250k
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), 250_000 * USDC);
        assertEq(_armOf(_knownAddr(0)), 100_000 * ARM);
        assertEq(_armOf(_smallAddr(0)), 10_000 * ARM);
        assertEq(_refundOf(_smallAddr(0)), 0);
        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT, "team paid exactly $250k");
        assertEq(usdc.balanceOf(treasury), 0, "treasury receives nothing at the minimum");
        assertEq(usdc.balanceOf(address(cf)), 0, "nothing stranded: no refunds owed");
    }

    // WHY: the brief's lower boundary: $249,999.999999 accepted is one unit below the minimum, so the
    //      sale must refund everyone and pay neither the team nor the treasury.
    function test_one_unit_below_minimum_enters_refund_mode() public {
        _addKnown(1);
        _placeSmall(15);
        _commitKnown(1, KNOWN_CAP);
        _commitSmall(14, SMALL_CAP);
        _commit(_smallAddr(14), 2, SMALL_CAP - 1); // $249,999.999999 in total
        assertEq(cf.totalCommitted(), 250_000 * USDC - 1);
        _finalize();

        assertTrue(cf.refundMode(), "one unit below the minimum refunds");
        assertEq(usdc.balanceOf(launchTeam), 0, "no team payment");
        assertEq(usdc.balanceOf(treasury), 0, "no proceeds");
        vm.prank(_smallAddr(14));
        cf.claimRefund();
        assertEq(usdc.balanceOf(_smallAddr(14)), SMALL_CAP - 1, "full refund");
    }

    // WHY: the brief's upper boundary: $250,000.000001 accepted succeeds with everyone filled in full;
    //      the team receives exactly $250k and the treasury exactly the one extra unit. No tier is
    //      pro-rated, so no rounding buffer is held back and nothing is stranded.
    function test_one_unit_over_minimum_pays_team_exactly_and_treasury_one_unit() public {
        _addKnown(2);
        _placeSmall(10);
        _commit(_knownAddr(0), 0, KNOWN_CAP);
        _commit(_knownAddr(1), 0, 50_000 * USDC + 1);
        _commitSmall(10, SMALL_CAP); // $100k + $50,000.000001 + $100k = $250,000.000001
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), 250_000 * USDC + 1);
        assertEq(_refundOf(_knownAddr(1)), 0, "filled in full");
        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT, "team paid exactly $250k");
        assertEq(usdc.balanceOf(treasury), 1, "treasury receives the one extra unit");
        assertEq(usdc.balanceOf(address(cf)), 0, "nothing stranded: no refunds owed");
    }

    // WHY: any tier mix that commits $250k must succeed. Three known contributors alone clear it.
    function test_known_tier_alone_clears_minimum() public {
        _addKnown(3);
        _commitKnown(3, KNOWN_CAP); // $300k, hop 0 only
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(_armOf(_knownAddr(2)), 100_000 * ARM);
        assertEq(_refundOf(_knownAddr(2)), 0);
    }

    // WHY: the $10k tier alone (25 contributors) must also clear the minimum.
    function test_small_tier_alone_clears_minimum() public {
        _placeSmall(25);
        _commitSmall(25, SMALL_CAP); // $250k, hop 2 only
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(_armOf(_smallAddr(24)), 10_000 * ARM);
    }

    // ============ Outcomes: the $300k Invited reserve against $1.8M ============

    // WHY: exactly $1.8M fills everyone in full; pro-rating only starts above it.
    function test_exactly_sale_size_fills_in_full() public {
        _addKnown(15);
        _placeSmall(30);
        _commitKnown(15, KNOWN_CAP); // $1.5M
        _commitSmall(30, SMALL_CAP); // $300k
        _finalize();

        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(_armOf(_knownAddr(14)), 100_000 * ARM);
        assertEq(_refundOf(_knownAddr(14)), 0);
        assertEq(_armOf(_smallAddr(29)), 10_000 * ARM);
    }

    // WHY: Known demand under its $1.5M earmark leaves capacity that rolls to Invited beyond its
    //      $300k reserve: $1.2M known + $900k small → known filled, small gets $300k + $300k = $600k
    //      of $900k (two thirds).
    function test_small_tier_takes_unused_known_capacity_then_pro_rated() public {
        _addKnown(12);
        _placeSmall(90);
        _commitKnown(12, KNOWN_CAP);
        _commitSmall(90, SMALL_CAP);
        _finalize();

        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(_armOf(_knownAddr(0)), 100_000 * ARM, "known filled");
        uint256 smallAccepted = (SMALL_CAP * 600_000 * USDC) / (900_000 * USDC);
        assertEq(_armOf(_smallAddr(0)), smallAccepted * 1e12, "small at 2/3");
        assertEq(_refundOf(_smallAddr(0)), SMALL_CAP - smallAccepted, "small refund");
    }

    // WHY: with the $300k reserve, Known demand above the sale cannot crowd Invited out: $2.0M known
    //      + $50k small → small filled in full; known shares the remaining $1.75M pro-rata. Unused
    //      reserve ($250k) rolls back to Known.
    function test_reserve_protects_small_tier_and_unused_reserve_rolls_to_known() public {
        _addKnown(20);
        _placeSmall(5);
        _commitKnown(20, KNOWN_CAP); // $2.0M known
        _commitSmall(5, SMALL_CAP);  // $50k small
        _finalize();

        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(_armOf(_smallAddr(0)), 10_000 * ARM, "small filled in full");
        uint256 knownAccepted = (KNOWN_CAP * 1_750_000 * USDC) / (2_000_000 * USDC);
        assertEq(_armOf(_knownAddr(0)), knownAccepted * 1e12, "known pro-rated to $1.75M");

        vm.prank(_smallAddr(0));
        cf.claim(delegatee);
        assertEq(armToken.balanceOf(_smallAddr(0)), 10_000 * ARM);
    }

    // WHY: when both tiers exceed their earmarks, Invited gets exactly its $300k reserve and Known
    //      exactly $1.5M, each pro-rated within the tier.
    function test_both_tiers_oversubscribed_split_at_the_earmarks() public {
        _addKnown(20);
        _placeSmall(60);
        _commitKnown(20, KNOWN_CAP); // $2.0M
        _commitSmall(60, SMALL_CAP); // $600k
        _finalize();

        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(_armOf(_knownAddr(0)), ((KNOWN_CAP * 1_500_000 * USDC) / (2_000_000 * USDC)) * 1e12, "known 75%");
        assertEq(_armOf(_smallAddr(0)), ((SMALL_CAP * RESERVE) / (600_000 * USDC)) * 1e12, "small 50%");
    }

    // ============ Team payment ============

    // WHY: above the minimum (no pro-rating) the team receives exactly $250k and the treasury the
    //      rest, with nothing held back.
    function test_team_paid_exactly_and_treasury_gets_the_rest() public {
        _addKnown(5);
        _commitKnown(5, KNOWN_CAP); // $500k
        vm.warp(cf.windowEnd() + 1);
        vm.expectEmit(true, false, false, true, address(cf));
        emit LaunchTeamPaid(launchTeam, TEAM_PAYMENT);
        cf.finalize();

        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT);
        assertEq(usdc.balanceOf(treasury), 250_000 * USDC);
    }

    // WHY: when a tier is pro-rated, per-participant floor division leaves dust, so a rounding buffer
    //      is held back from the treasury's share; the team still receives exactly $250k, and every
    //      participant's claim (ARM + refund) must succeed from what remains.
    function test_oversubscribed_pays_team_exactly_and_keeps_refunds_solvent() public {
        _addKnown(21);
        _placeSmall(7);
        _commitKnown(21, KNOWN_CAP); // $2.1M (prime-ish split → floor dust)
        _commitSmall(7, 7_777 * USDC);
        _finalize();

        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT, "team paid exactly");
        uint256 buffer = cf.getParticipantCount();
        assertEq(usdc.balanceOf(treasury), SALE - TEAM_PAYMENT - buffer, "treasury gets the rest less the buffer");

        for (uint256 i = 0; i < 21; i++) {
            vm.prank(_knownAddr(i));
            cf.claim(delegatee);
        }
        for (uint256 i = 0; i < 7; i++) {
            vm.prank(_smallAddr(i));
            cf.claim(delegatee);
        }
        // Every refund was paid; only the unspent part of the buffer (dust) remains.
        assertLe(usdc.balanceOf(address(cf)), buffer, "at most the buffer remains");
    }

    // WHY: a cancelled sale pays nobody: no team payment, no proceeds, every deposit refundable.
    function test_cancel_pays_no_team_payment() public {
        _addKnown(5);
        _commitKnown(5, KNOWN_CAP);
        vm.prank(securityCouncil);
        cf.cancel();
        assertEq(usdc.balanceOf(launchTeam), 0);
        vm.prank(_knownAddr(0));
        cf.claimRefund();
        assertEq(usdc.balanceOf(_knownAddr(0)), KNOWN_CAP);
    }

    // WHY: finalize cannot run twice, so the team payment cannot be taken twice.
    function test_team_payment_cannot_be_taken_twice() public {
        _addKnown(5);
        _commitKnown(5, KNOWN_CAP);
        _finalize();
        vm.expectRevert("ArmadaCrowdfund: already finalized");
        cf.finalize();
        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT);
    }

    // WHY: if the USDC transfer to the launch team fails (e.g. the token pauses), finalize must
    //      revert as a whole, leaving the sale finalizable later — never a half-paid settlement.
    function test_failed_team_transfer_reverts_finalize_atomically() public {
        _addKnown(5);
        _commitKnown(5, KNOWN_CAP);
        vm.warp(cf.windowEnd() + 1);
        vm.mockCallRevert(
            address(usdc),
            abi.encodeWithSelector(IERC20.transfer.selector, launchTeam, TEAM_PAYMENT),
            "paused"
        );
        vm.expectRevert();
        cf.finalize();
        assertEq(uint256(cf.phase()), uint256(Phase.Active), "still active");
        vm.clearMockedCalls();
        cf.finalize();
        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT);
    }

    // ============ Team wallets (hop 1) ============

    // WHY: team wallets have a $0 cap. An accidental commit must not count towards demand,
    //      must earn no ARM, and must be fully refundable through claim() after a success.
    function test_team_wallet_commit_is_excluded_and_refunded() public {
        address team = vm.addr(TEAM_WALLET_PK);
        vm.prank(launchTeam);
        cf.launchTeamInvite(team, 0);
        _addKnown(3);
        _commitKnown(3, KNOWN_CAP);
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

    // WHY: the team wallet issues exactly 100 links into the $10k tier; the 101st is rejected.
    function test_team_wallet_issues_100_links_then_stops() public {
        vm.prank(launchTeam);
        cf.launchTeamInvite(vm.addr(TEAM_WALLET_PK), 0);

        for (uint256 i = 0; i < 100; i++) _redeemLink(_linkAddr(i), i + 1, 100 * USDC);
        assertTrue(cf.isWhitelisted(_linkAddr(99), 2));
        assertEq(cf.getInvitesRemaining(vm.addr(TEAM_WALLET_PK), 1), 0);

        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInvite(TEAM_WALLET_PK, 1, 101, deadline);
        address extra = _linkAddr(100);
        usdc.mint(extra, 100 * USDC);
        vm.startPrank(extra);
        usdc.approve(address(cf), 100 * USDC);
        vm.expectRevert("ArmadaCrowdfund: invite limit reached");
        cf.commitWithInvite(vm.addr(TEAM_WALLET_PK), 1, 101, deadline, sig, 100 * USDC);
        vm.stopPrank();
    }

    // WHY: stacking at the $10k tier: each further link redeemed by the same address adds a $10k
    //      slot, up to 20 ($200k). The 21st reverts, and because the whole transaction reverts that
    //      link stays unused.
    function test_links_stack_up_to_20_slots_then_revert_without_using_it() public {
        vm.prank(launchTeam);
        cf.launchTeamInvite(vm.addr(TEAM_WALLET_PK), 0);
        address invitee = _linkAddr(0);
        for (uint256 n = 1; n <= 20; n++) _redeemLink(invitee, n, 100 * USDC);
        assertEq(cf.getEffectiveCap(invitee, 2), 20 * SMALL_CAP, "20 stacked slots");

        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInvite(TEAM_WALLET_PK, 1, 21, deadline);
        usdc.mint(invitee, 100 * USDC);
        vm.startPrank(invitee);
        usdc.approve(address(cf), 100 * USDC);
        vm.expectRevert("ArmadaCrowdfund: max invites received");
        cf.commitWithInvite(vm.addr(TEAM_WALLET_PK), 1, 21, deadline, sig, 100 * USDC);
        vm.stopPrank();
        assertFalse(cf.usedNonces(vm.addr(TEAM_WALLET_PK), 21), "link not consumed");
        assertEq(cf.getEffectiveCap(invitee, 2), 20 * SMALL_CAP, "cap unchanged");
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
    //      exactly 500 and reject the 501st. The hop-1 budget (1) rejects a second team wallet.
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
        assertEq(hop1Remaining, 1);
        assertEq(hop2Remaining, 0);

        vm.startPrank(launchTeam);
        cf.launchTeamInvite(address(uint160(0x20000000)), 0);
        vm.expectRevert("ArmadaCrowdfund: hop-1 budget exhausted");
        cf.launchTeamInvite(address(uint160(0x20000001)), 0);
        vm.stopPrank();
    }

    // WHY: the most participants this configuration allows is 1,101 (500 known + 1 team wallet
    //      + 500 direct $10k placements + 100 link redemptions to distinct addresses; stacking only
    //      adds slots to existing nodes), under the 1,800 limit; finalize over all of them, every one
    //      committed, must fit in the 2^24 per-transaction gas cap.
    //      (Warm-storage measurement; CrowdfundFinalizeGasCold measures the cold per-node cost.)
    function test_maximum_participants_finalize_within_gas_cap() public {
        _addKnown(500);
        _placeSmall(500);
        vm.prank(launchTeam);
        cf.launchTeamInvite(vm.addr(TEAM_WALLET_PK), 0);
        for (uint256 i = 0; i < 100; i++) _redeemLink(_linkAddr(i), i + 1, 100 * USDC);
        // Known tier at full caps: success path, with the known tier oversubscribed.
        _commitKnown(500, KNOWN_CAP);
        _commitSmall(500, 100 * USDC);
        assertEq(cf.getParticipantCount(), 1101, "maximum participants");

        vm.warp(cf.windowEnd() + 1);
        uint256 before = gasleft();
        cf.finalize();
        uint256 used = before - gasleft();
        assertLt(used, 16_777_216, "finalize must fit the per-transaction gas cap");
        assertFalse(cf.refundMode());
        assertEq(cf.totalAllocatedUsdc(), SALE);
        assertEq(usdc.balanceOf(launchTeam), TEAM_PAYMENT);
    }
}

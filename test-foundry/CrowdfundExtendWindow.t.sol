// ABOUTME: Tests for ArmadaCrowdfund.extendWindow, the launch team's bounded window extension.
// ABOUTME: Covers access control, timing bounds, the max-window cap, and behavior during an extension.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract CrowdfundExtendWindowTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    ArmadaCrowdfund public cf;

    address public treasury = address(0xCAFE);
    address public launchTeam = address(0x1A0);
    address public securityCouncil = address(0x5C0);
    address public seed = address(0x5EED);
    address public outsider = address(0xBAD);

    uint256 constant ARM_FUNDING = 1_500_000 * 1e18;

    event WindowExtended(uint256 previousEnd, uint256 newEnd);

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(address(this), address(this));
        address[] memory wl = new address[](1);
        wl[0] = address(this);
        armToken.initWhitelist(wl);

        cf = new ArmadaCrowdfund(address(usdc), address(armToken), treasury, launchTeam, securityCouncil, block.timestamp);
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();

        vm.prank(launchTeam);
        cf.addSeed(seed);
    }

    function _maxEnd() internal view returns (uint256) {
        return cf.windowStart() + cf.MAX_WINDOW_DURATION();
    }

    function _extend(uint256 newEnd) internal {
        vm.prank(launchTeam);
        cf.extendWindow(newEnd);
    }

    function _mintAndApprove(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(cf), amount);
    }

    // ============ Configuration ============

    // WHY: the extension cap must allow a real extension beyond the base window, otherwise
    //      extendWindow could never succeed and the feature would be dead on deploy.
    function test_max_window_exceeds_base_window() public view {
        assertGt(cf.MAX_WINDOW_DURATION(), cf.WINDOW_DURATION(), "max window must exceed base window");
    }

    // ============ Happy path ============

    // WHY: an extension must move BOTH the commit window and the launch-team window. If only
    //      windowEnd moved, commits would stay open while launch-team whitelisting closed at
    //      the original end, so nobody new could be let in during the extension.
    function test_extend_moves_window_end_and_launch_team_end() public {
        uint256 oldEnd = cf.windowEnd();
        uint256 newEnd = oldEnd + 2 days;

        vm.expectEmit(false, false, false, true, address(cf));
        emit WindowExtended(oldEnd, newEnd);
        _extend(newEnd);

        assertEq(cf.windowEnd(), newEnd, "windowEnd not extended");
        assertEq(cf.launchTeamInviteEnd(), newEnd, "launchTeamInviteEnd not extended");
        assertEq(cf.windowStart(), block.timestamp, "windowStart must not change");
    }

    // WHY: commits are allowed through windowEnd inclusive and finalize needs windowEnd + 1,
    //      so the final second of the window is still "open" and must be extendable.
    function test_extend_allowed_at_final_second() public {
        uint256 oldEnd = cf.windowEnd();
        vm.warp(oldEnd);
        _extend(oldEnd + 1 days);
        assertEq(cf.windowEnd(), oldEnd + 1 days);
    }

    // WHY: the cap is inclusive, so the launch team can extend to exactly the maximum.
    function test_extend_to_exact_max() public {
        _extend(_maxEnd());
        assertEq(cf.windowEnd(), _maxEnd());
    }

    // WHY: the launch team may extend in steps (e.g. a day at a time) as long as each step
    //      moves later and the total stays within the cap.
    function test_multiple_extensions() public {
        uint256 oldEnd = cf.windowEnd();
        _extend(oldEnd + 1 days);
        _extend(oldEnd + 2 days);
        _extend(_maxEnd());
        assertEq(cf.windowEnd(), _maxEnd());
        assertEq(cf.launchTeamInviteEnd(), _maxEnd());
    }

    // ============ Access control ============

    // WHY: extending prolongs the lock-up of every participant's USDC; only the launch team may do it.
    function test_reverts_for_non_launch_team() public {
        uint256 newEnd = cf.windowEnd() + 1 days;

        vm.prank(outsider);
        vm.expectRevert("ArmadaCrowdfund: not launch team");
        cf.extendWindow(newEnd);

        vm.prank(securityCouncil);
        vm.expectRevert("ArmadaCrowdfund: not launch team");
        cf.extendWindow(newEnd);

        vm.prank(seed);
        vm.expectRevert("ArmadaCrowdfund: not launch team");
        cf.extendWindow(newEnd);
    }

    // ============ Timing bounds ============

    // WHY: once windowEnd has passed, anyone may finalize. Allowing an extension after that
    //      would let the launch team reopen a closed sale and race the finalize call.
    function test_reverts_after_window_ended() public {
        uint256 oldEnd = cf.windowEnd();
        vm.warp(oldEnd + 1);

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: window ended");
        cf.extendWindow(oldEnd + 1 days);
    }

    // WHY: extendWindow may only lengthen the window. Shortening (or a no-op) would let the
    //      launch team cut participants off early.
    function test_reverts_when_not_later() public {
        uint256 oldEnd = cf.windowEnd();

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: must extend window");
        cf.extendWindow(oldEnd);

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: must extend window");
        cf.extendWindow(oldEnd - 1);
    }

    // WHY: the hard cap bounds how long participant funds can be locked; it is the main
    //      protection participants have against an open-ended sale.
    function test_reverts_beyond_max() public {
        uint256 maxEnd = _maxEnd();

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: exceeds max window");
        cf.extendWindow(maxEnd + 1);
    }

    // WHY: the cap is measured from windowStart, not from the current end, so repeated
    //      extensions cannot ratchet past it.
    function test_reverts_beyond_max_after_prior_extension() public {
        _extend(cf.windowEnd() + 1 days);
        // Compute before vm.prank: the view calls inside _maxEnd() would consume the prank.
        uint256 beyondMax = _maxEnd() + 1;

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: exceeds max window");
        cf.extendWindow(beyondMax);
    }

    // WHY: a canceled sale is terminal; extending it would be meaningless and confusing.
    function test_reverts_when_canceled() public {
        vm.prank(securityCouncil);
        cf.cancel();
        // Compute before vm.prank: the windowEnd() view call would consume the prank.
        uint256 newEnd = cf.windowEnd() + 1 days;

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: not active");
        cf.extendWindow(newEnd);
    }

    // ============ Behavior during an extension ============

    // WHY: the point of extending is that participants can keep committing after the original end.
    function test_commit_allowed_during_extension() public {
        uint256 oldEnd = cf.windowEnd();
        _extend(oldEnd + 2 days);
        vm.warp(oldEnd + 1 days);

        uint256 amount = 1_000 * 1e6;
        _mintAndApprove(seed, amount);
        vm.prank(seed);
        cf.commit(0, amount);

        assertEq(cf.getCommitment(seed, 0), amount, "commit during extension failed");
    }

    // WHY: the launch team must be able to keep whitelisting during an extension (seeds and
    //      direct invites), since that is the usual reason to extend an undersubscribed sale.
    function test_launch_team_can_whitelist_during_extension() public {
        uint256 oldEnd = cf.windowEnd();
        _extend(oldEnd + 2 days);
        vm.warp(oldEnd + 1 days);

        address lateSeed = address(0x5EED2);
        address lateHop1 = address(0x1111);
        vm.startPrank(launchTeam);
        cf.addSeed(lateSeed);
        cf.launchTeamInvite(lateHop1, 0);
        vm.stopPrank();

        assertTrue(cf.isWhitelisted(lateSeed, 0), "late seed not whitelisted");
        assertTrue(cf.isWhitelisted(lateHop1, 1), "late hop-1 invite not whitelisted");
    }

    // WHY: participant invites use the same windowEnd check and must follow the extension too.
    //      Only hop-1 (team inviter wallets) can invite, so the inviter is placed there.
    function test_participant_invite_allowed_during_extension() public {
        address inviter = address(0x1111);
        vm.prank(launchTeam);
        cf.launchTeamInvite(inviter, 0);

        uint256 oldEnd = cf.windowEnd();
        _extend(oldEnd + 2 days);
        vm.warp(oldEnd + 1 days);

        address invitee = address(0x2222);
        vm.prank(inviter);
        cf.invite(invitee, 1);
        assertTrue(cf.isWhitelisted(invitee, 2), "invite during extension failed");
    }

    // WHY: finalize must respect the extended end. Finalizing at the original end would cut
    //      the extension short and strand commits made in it.
    function test_finalize_blocked_until_extended_end() public {
        uint256 oldEnd = cf.windowEnd();
        uint256 newEnd = oldEnd + 2 days;
        _extend(newEnd);

        vm.warp(oldEnd + 1);
        vm.expectRevert("ArmadaCrowdfund: window not ended");
        cf.finalize();

        vm.warp(newEnd);
        vm.expectRevert("ArmadaCrowdfund: window not ended");
        cf.finalize();

        vm.warp(newEnd + 1);
        cf.finalize();
        assertEq(uint256(cf.phase()), uint256(Phase.Finalized), "finalize after extended end failed");
    }

    // WHY: after the extended end, commits and further extensions must both be closed.
    function test_closed_after_extended_end() public {
        uint256 newEnd = cf.windowEnd() + 2 days;
        _extend(newEnd);
        vm.warp(newEnd + 1);

        uint256 amount = 1_000 * 1e6;
        _mintAndApprove(seed, amount);
        vm.prank(seed);
        vm.expectRevert("ArmadaCrowdfund: not active window");
        cf.commit(0, amount);

        vm.prank(launchTeam);
        vm.expectRevert("ArmadaCrowdfund: window ended");
        cf.extendWindow(newEnd + 1 days);
    }

    // ============ Fuzz ============

    // WHY: for any requested end and any time inside the window, extendWindow either reverts
    //      and leaves the window untouched, or sets both ends to exactly the requested value,
    //      which is always later than before and within the cap.
    function testFuzz_extend_is_monotonic_and_capped(uint256 newEnd, uint256 elapsed) public {
        uint256 oldEnd = cf.windowEnd();
        elapsed = bound(elapsed, 0, oldEnd - block.timestamp);
        vm.warp(block.timestamp + elapsed);

        vm.prank(launchTeam);
        try cf.extendWindow(newEnd) {
            assertEq(cf.windowEnd(), newEnd);
            assertEq(cf.launchTeamInviteEnd(), newEnd);
            assertGt(newEnd, oldEnd);
            assertLe(newEnd, _maxEnd());
        } catch {
            assertEq(cf.windowEnd(), oldEnd);
            assertEq(cf.launchTeamInviteEnd(), oldEnd);
            assertTrue(newEnd <= oldEnd || newEnd > _maxEnd(), "valid extension reverted");
        }
    }
}

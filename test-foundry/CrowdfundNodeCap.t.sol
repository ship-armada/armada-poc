// ABOUTME: Boundary tests for participant-node limits: the launch-team and invite budgets cap the tree at
// ABOUTME: 1,101 nodes, below MAX_FINALIZE_NODES, and every node-creation path is exhausted before that cap.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice MAX_FINALIZE_NODES (1,800) keeps one-shot finalize() under the 16,777,216 (2^24,
///         EIP-7825) per-tx gas cap; all node creation funnels through _initParticipant. With the
///         relaunch budgets the tree tops out at 1,101 nodes (500 seeds + 1 team wallet + 500
///         launch-team hop-2 placements + 100 team-wallet invites; stacking adds slots, not nodes),
///         so the budgets — not the node cap — are what bound finalize() gas. These tests pin that
///         every creation path runs out first. (The node-cap require is unreachable in this
///         configuration.)
contract CrowdfundNodeCapTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    ArmadaCrowdfund public cf;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant CAP = 1800; // MAX_FINALIZE_NODES
    uint256 constant STRUCTURAL_MAX = 1101;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);
        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);

        cf = new ArmadaCrowdfund(address(usdc), address(armToken), treasury, admin, admin, block.timestamp);
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();
    }

    function _seedAddr(uint256 i) internal pure returns (address) { return address(uint160(0x10000000 + i)); }
    function _teamAddr(uint256 i) internal pure returns (address) { return address(uint160(0x20000000 + i)); }
    function _hop2Addr(uint256 i) internal pure returns (address) { return address(uint160(0x30000000 + i)); }

    /// @dev Exhaust every node-creation budget: 500 seeds, the hop-1 team wallet
    ///      (launch team) inviting 100 hop-2 nodes (peer invite), and 500 launch-team hop-2
    ///      placements, every invite to a distinct address.
    function _fillToStructuralMax() internal {
        address[] memory seeds = new address[](500);
        for (uint256 i = 0; i < 500; i++) seeds[i] = _seedAddr(i);
        cf.addSeeds(seeds);

        cf.launchTeamInvite(_teamAddr(0), 0);
        for (uint256 j = 0; j < 100; j++) {
            vm.prank(_teamAddr(0));
            cf.invite(_hop2Addr(j), 1);
        }

        for (uint256 i = 0; i < 500; i++) cf.launchTeamInvite(_hop2Addr(100 + i), 1);
    }

    // WHY: the budgets must cap the tree at exactly 1,101 nodes, below the 1,800 node cap, so
    //      finalize() can never be pushed past the gas cap however the budgets are used.
    function test_structural_max_is_below_cap() public {
        _fillToStructuralMax();
        assertEq(cf.getParticipantCount(), STRUCTURAL_MAX, "structural maximum");
        assertLt(cf.getParticipantCount(), CAP, "below MAX_FINALIZE_NODES");
    }

    // WHY: at the structural maximum, the launch-team paths (seeds, hop-1 and hop-2 placements)
    //      must all be exhausted by their own budgets — none may reach the node cap.
    function test_launch_team_paths_exhausted_before_cap() public {
        _fillToStructuralMax();

        vm.expectRevert("ArmadaCrowdfund: seed cap reached");
        cf.addSeed(_seedAddr(9000));
        vm.expectRevert("ArmadaCrowdfund: hop-1 budget exhausted");
        cf.launchTeamInvite(_teamAddr(9000), 0);
        vm.expectRevert("ArmadaCrowdfund: hop-2 budget exhausted");
        cf.launchTeamInvite(_hop2Addr(9000), 1);
    }

    // WHY: the peer path (team-wallet invites, direct or by link) must also be exhausted by the
    //      wallet's invite budget (1 × 100) before the node cap. Hop-0 and hop-2 cannot invite.
    function test_peer_invite_paths_exhausted_before_cap() public {
        _fillToStructuralMax();

        vm.prank(_teamAddr(0));
        vm.expectRevert("ArmadaCrowdfund: invite limit reached");
        cf.invite(_hop2Addr(9001), 1);

        vm.prank(_seedAddr(0));
        vm.expectRevert("ArmadaCrowdfund: invite limit reached");
        cf.invite(_hop2Addr(9002), 0);

        vm.prank(_hop2Addr(0));
        vm.expectRevert("ArmadaCrowdfund: max hop reached");
        cf.invite(_hop2Addr(9003), 2);
    }
}

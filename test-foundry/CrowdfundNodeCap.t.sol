// ABOUTME: Boundary tests for the MAX_FINALIZE_NODES participant cap in ArmadaCrowdfund.
// ABOUTME: Verifies node creation is allowed up to the cap and reverts beyond it, across paths.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice The cap keeps one-shot finalize() under the 16,777,216 (2^24, EIP-7825) per-tx gas cap.
///         All node creation funnels through _initParticipant, so one require guards every path
///         (seeds, peer invite, launch-team invite, commitWithInvite). These tests exercise the
///         boundary on the reachable paths.
contract CrowdfundNodeCapTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    ArmadaCrowdfund public cf;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant CAP = 1800; // MAX_FINALIZE_NODES

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
    function _hop1Addr(uint256 i) internal pure returns (address) { return address(uint160(0x20000000 + i)); }
    function _hop2Addr(uint256 i) internal pure returns (address) { return address(uint160(0x30000000 + i)); }

    /// @dev Fill the tree to exactly `target` nodes via seeds + peer invites (launch-team budget
    ///      untouched, so LT paths stay available to probe the boundary). 180 seeds + 540 hop-1 +
    ///      1080 hop-2 = 1800 exactly. target ≤ 1800.
    function _fillTo(uint256 target) internal {
        require(target <= 1800, "target too high");
        uint256 seedCount = target < 180 ? target : 180;
        address[] memory seeds = new address[](seedCount);
        for (uint256 i = 0; i < seedCount; i++) seeds[i] = _seedAddr(i);
        cf.addSeeds(seeds);
        if (cf.getParticipantCount() >= target) return;

        uint256 h1 = 0;
        for (uint256 i = 0; i < seedCount && cf.getParticipantCount() < target; i++) {
            for (uint256 j = 0; j < 3 && cf.getParticipantCount() < target; j++) {
                vm.prank(_seedAddr(i));
                cf.invite(_hop1Addr(h1), 0);
                h1++;
            }
        }
        if (cf.getParticipantCount() >= target) return;

        for (uint256 i = 0; i < h1 && cf.getParticipantCount() < target; i++) {
            for (uint256 j = 0; j < 2 && cf.getParticipantCount() < target; j++) {
                vm.prank(_hop1Addr(i));
                cf.invite(_hop2Addr(i * 2 + j), 1);
            }
        }
    }

    // WHY: the cap must admit EXACTLY MAX_FINALIZE_NODES nodes — one short would needlessly shrink
    //      the sale, one over would make finalize() unsubmittable. Confirms the boundary is inclusive.
    function test_allows_exactly_cap() public {
        _fillTo(CAP);
        assertEq(cf.getParticipantCount(), CAP, "should reach exactly the cap");
    }

    // WHY: creating the (cap+1)-th node must revert. Probed via launchTeamInvite because _fillTo
    //      leaves the launch-team budget untouched.
    function test_reverts_over_cap_launchTeamInvite() public {
        _fillTo(CAP);
        vm.expectRevert("ArmadaCrowdfund: node cap reached");
        cf.launchTeamInvite(_hop1Addr(9000), 0);
    }

    // WHY: the guard sits at the single choke point (_initParticipant), so the peer invite() path
    //      must revert at the cap too. Fill to cap-1, add one node via LT to hit the cap exactly,
    //      then a peer node with spare budget attempts an invite → must revert.
    function test_reverts_over_cap_peer_invite() public {
        _fillTo(CAP - 1);
        cf.launchTeamInvite(_hop1Addr(9001), 0); // → exactly CAP nodes
        assertEq(cf.getParticipantCount(), CAP);
        // hop-1 node #539 has one unused hop-2 slot at 1799 nodes (the 1080th hop-2 was never added).
        vm.prank(_hop1Addr(539));
        vm.expectRevert("ArmadaCrowdfund: node cap reached");
        cf.invite(_hop2Addr(9002), 1);
    }
}

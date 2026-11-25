// ABOUTME: Fuzzes whole relaunch sales (stacked hop-2 positions, over-cap and split commits, links) end to end.
// ABOUTME: Checks the exact team payment, every claim against computeAllocation, and the settlement identity.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Each run builds a random relaunch sale from one seed: 1–30 known contributors (random
///         commits up to 1.5× the $100k cap, sometimes split in two, sometimes also placed at hop 2),
///         the team wallet (a refunded commit at its $0 cap), and up to 25 invited addresses, each
///         stacking 1–20 hop-2 invites from a mix of launch-team placements and team-wallet links,
///         committing both before and after its cap grows. After finalize it sometimes sweeps
///         unsold ARM before anyone claims, then every participant claims.
contract CrowdfundSettlementFuzzTest is Test {
    MockUSDCV2 internal usdc;
    ArmadaToken internal armToken;
    ArmadaCrowdfund internal cf;

    address internal constant TREASURY = address(0xCAFE);
    address internal constant LAUNCH_TEAM = address(0x1A0);
    address internal constant SECURITY_COUNCIL = address(0x5C0);
    address internal constant DELEGATEE = address(0xDE1E);
    uint256 internal constant TEAM_WALLET_PK = 0xA11CE;

    uint256 internal constant USDC = 1e6;
    uint256 internal constant SALE = 1_800_000 * USDC;
    uint256 internal constant TEAM_PAYMENT = 250_000 * USDC;
    uint256 internal constant SLOT_CAP = 10_000 * USDC;
    uint256 internal constant MIN_COMMIT = 100 * USDC;

    // Per-run participant bookkeeping (reset by each fuzz run's fresh setUp).
    address[] internal participants;
    mapping(address => uint256) internal committedBy;
    mapping(address => bool) internal seen;
    uint256 internal nextLinkNonce = 1; // link nonces start at 1 (0 is refused)

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(address(this), address(this));
        address[] memory wl = new address[](1);
        wl[0] = address(this);
        armToken.initWhitelist(wl);
        cf = new ArmadaCrowdfund(address(usdc), address(armToken), TREASURY, LAUNCH_TEAM, SECURITY_COUNCIL, block.timestamp);
        armToken.addToWhitelist(address(cf));
        address[] memory delegators = new address[](1);
        delegators[0] = address(cf);
        armToken.initAuthorizedDelegators(delegators);
        armToken.transfer(address(cf), 1_800_000 * 1e18);
        cf.loadArm();
    }

    // ============ Helpers ============

    function _rand(uint256 seed, uint256 tag, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, tag, i)));
    }

    function _track(address who, uint256 amount) internal {
        if (!seen[who]) {
            seen[who] = true;
            participants.push(who);
        }
        committedBy[who] += amount;
    }

    function _commit(address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(cf), amount);
        cf.commit(hop, amount);
        vm.stopPrank();
        _track(who, amount);
    }

    /// @dev Redeem a fresh team-wallet link (fromHop 1 → hop 2) for `invitee`, committing `amount`.
    function _redeemLink(address invitee, uint256 amount) internal {
        uint256 nonce = nextLinkNonce++;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("ArmadaCrowdfund")), keccak256(bytes("1")), block.chainid, address(cf)
        ));
        bytes32 structHash = keccak256(abi.encode(cf.INVITE_TYPEHASH(), vm.addr(TEAM_WALLET_PK), uint8(1), nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEAM_WALLET_PK, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        usdc.mint(invitee, amount);
        vm.startPrank(invitee);
        usdc.approve(address(cf), amount);
        cf.commitWithInvite(vm.addr(TEAM_WALLET_PK), 1, nonce, deadline, abi.encodePacked(r, s, v), amount);
        vm.stopPrank();
        _track(invitee, amount);
    }

    function _placeHop2(address who) internal {
        vm.prank(LAUNCH_TEAM);
        cf.launchTeamInvite(who, 1);
    }

    /// @dev Builds the random sale from `seed`.
    function _buildSale(uint256 seed) internal {
        // Known contributors: commits up to 1.5× the cap, sometimes in two parts.
        uint256 nKnown = 1 + _rand(seed, 1, 0) % 30;
        address[] memory seeds = new address[](nKnown);
        for (uint256 i = 0; i < nKnown; i++) seeds[i] = address(uint160(0x10000000 + i));
        vm.prank(LAUNCH_TEAM);
        cf.addSeeds(seeds);
        for (uint256 i = 0; i < nKnown; i++) {
            uint256 amount = MIN_COMMIT + _rand(seed, 2, i) % (150_000 * USDC);
            if (_rand(seed, 3, i) % 3 == 0 && amount >= 2 * MIN_COMMIT) {
                _commit(seeds[i], 0, amount / 2);
                _commit(seeds[i], 0, amount - amount / 2);
            } else {
                _commit(seeds[i], 0, amount);
            }
            // Occasionally the same address also holds a hop-2 position.
            if (_rand(seed, 4, i) % 7 == 0) {
                _placeHop2(seeds[i]);
                _commit(seeds[i], 2, SLOT_CAP);
            }
        }

        // The team wallet: a $0-cap position whose commit is refunded in full.
        address teamWallet = vm.addr(TEAM_WALLET_PK);
        vm.prank(LAUNCH_TEAM);
        cf.launchTeamInvite(teamWallet, 0);
        _commit(teamWallet, 1, MIN_COMMIT);

        // Invited addresses: 1–20 stacked invites from placements and links, commits before and
        // after the cap grows.
        uint256 nInvited = _rand(seed, 5, 0) % 26;
        for (uint256 j = 0; j < nInvited; j++) {
            address who = address(uint160(0x30000000 + j));
            uint256 invites = 1 + _rand(seed, 6, j) % 20;
            uint256 links = _rand(seed, 7, j) % (invites + 1);
            uint256 linksLeft = 100 - (nextLinkNonce - 1); // the team wallet issues 100 links
            if (links > linksLeft) links = linksLeft;
            uint256 early = MIN_COMMIT + _rand(seed, 8, j) % (15_000 * USDC);
            for (uint256 k = 0; k < invites; k++) {
                bool viaLink = k < links;
                if (k == 0) {
                    if (viaLink) {
                        _redeemLink(who, early);
                    } else {
                        _placeHop2(who);
                        _commit(who, 2, early);
                    }
                } else if (viaLink) {
                    _redeemLink(who, MIN_COMMIT);
                } else {
                    _placeHop2(who);
                }
            }
            uint256 late = _rand(seed, 9, j) % (invites * 13_000 * USDC);
            if (late >= MIN_COMMIT) _commit(who, 2, late);
        }
    }

    // ============ The fuzz ============

    /// @notice WHY: the per-hop allocation, the exact team payment, the rounding buffer and every
    ///         participant's claim must agree for any mix of tiers, stacked caps, over-cap and split
    ///         commits, and claim order — including an unsold-ARM sweep before anyone claims. No claim
    ///         may ever run short, and USDC is conserved:
    ///         team payment + treasury + refunds + dust == total committed, with dust < participant nodes.
    function testFuzz_wholeSaleSettlesExactly(uint256 seed) public {
        _buildSale(seed);
        uint256 totalCommitted = cf.totalCommitted();

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        if (cf.refundMode()) {
            assertEq(usdc.balanceOf(LAUNCH_TEAM), 0, "refund mode: no team payment");
            assertEq(usdc.balanceOf(TREASURY), 0, "refund mode: no proceeds");
            for (uint256 i = 0; i < participants.length; i++) {
                address who = participants[i];
                uint256 before = usdc.balanceOf(who);
                vm.prank(who);
                cf.claimRefund();
                assertEq(usdc.balanceOf(who) - before, committedBy[who], "refund mode: full refund");
            }
            assertEq(usdc.balanceOf(address(cf)), 0, "refund mode: nothing left");
            return;
        }

        uint256 teamPaid = usdc.balanceOf(LAUNCH_TEAM);
        uint256 treasuryPaid = usdc.balanceOf(TREASURY);
        assertEq(teamPaid, TEAM_PAYMENT, "team paid exactly $250k");
        uint256 capped = cf.cappedDemand();
        assertEq(cf.totalAllocatedUsdc(), capped < SALE ? capped : SALE, "allocation = min(capped demand, sale)");
        assertEq(teamPaid + treasuryPaid + usdc.balanceOf(address(cf)), totalCommitted, "pre-claim conservation");

        // Sometimes sweep unsold ARM before anyone claims: it must never take ARM still owed.
        if (_rand(seed, 10, 0) % 2 == 0 && armToken.balanceOf(address(cf)) > cf.armStillOwed()) {
            cf.withdrawUnallocatedArm();
        }

        uint256 refunds;
        uint256 armOut;
        for (uint256 i = 0; i < participants.length; i++) {
            address who = participants[i];
            (uint256 arm, uint256 refund) = cf.computeAllocation(who);
            uint256 usdcBefore = usdc.balanceOf(who);
            uint256 armBefore = armToken.balanceOf(who);
            vm.prank(who);
            cf.claim(arm > 0 ? DELEGATEE : address(0));
            assertEq(usdc.balanceOf(who) - usdcBefore, refund, "claim refund = computeAllocation");
            assertEq(armToken.balanceOf(who) - armBefore, arm, "claim ARM = computeAllocation");
            refunds += refund;
            armOut += arm;
        }

        uint256 dust = usdc.balanceOf(address(cf));
        assertEq(teamPaid + treasuryPaid + refunds + dust, totalCommitted, "settlement identity");
        assertLt(dust, cf.getParticipantCount() + 1, "dust within the rounding buffer");
        if (capped <= SALE) assertEq(dust, 0, "no pro-rating, no dust");
        assertLe(armOut, cf.totalAllocatedArm(), "ARM paid within the allocation");
    }
}

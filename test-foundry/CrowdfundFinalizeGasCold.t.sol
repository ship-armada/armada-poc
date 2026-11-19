// ABOUTME: Cold-storage gas profile of ArmadaCrowdfund.finalize() up to the relaunch structural max (1,101).
// ABOUTME: Uses vm.cool() to model a real tx's first-touch SLOADs vs the warm in-test measurement.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Cold-storage finalize() gas profile + the regression guard that one-shot finalize() at
///         the largest reachable tree stays under the EIP-7825 per-tx gas cap (16,777,216 = 2^24).
///         Method (ported from the closed spike PR #266): vm.cool() before finalize() so first-touch
///         SLOADs are cold — a real transaction is its own tx and nothing is pre-warmed. Contrast
///         CrowdfundFinalizeGas.t.sol, which measures WARM slots (pre-warmed by _populate in the
///         same test tx) and so understates real finalize() gas by ~3.6x.
///
///         Historical: under the July-2026 fan-out the structural max was 2,220 nodes (~18.6M gas
///         cold, OVER the 2^24 cap), which motivated MAX_FINALIZE_NODES = 1,800. Under the relaunch
///         budgets the tree tops out at 1,101 nodes (500 seeds + 1 team wallet + 100 team-wallet
///         invites + 500 launch-team hop-2 placements; stacking adds slots, not nodes), below the
///         node cap, so the guards below run at that structural max.
contract CrowdfundFinalizeGasColdTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant STRUCTURAL_MAX = 1101;
    uint256 constant TX_GAS_CAP = 16_777_216; // EIP-7825 per-tx cap (2^24)
    uint256 constant MIN_COMMIT = 100 * 1e6;    // ArmadaCrowdfund.MIN_COMMIT

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);

        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);
    }

    function _deploy() internal returns (ArmadaCrowdfund cf) {
        cf = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, admin, admin, block.timestamp
        );
        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();
    }

    function _seedAddr(uint256 i) internal pure returns (address) { return address(uint160(0x10000000 + i)); }
    function _teamAddr(uint256 i) internal pure returns (address) { return address(uint160(0x20000000 + i)); }
    function _hop2Addr(uint256 i) internal pure returns (address) { return address(uint160(0x30000000 + i)); }

    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(cf), amount);
        vm.prank(who);
        cf.commit(hop, amount);
    }

    /// @dev Build the tree for (seeds, team wallets, team-wallet invites, launch-team hop-2
    ///      placements). Commit amounts: seeds at hop0Amt, every other node at MIN_COMMIT (team
    ///      wallets too, refunded in full), so the iteration body runs for every node.
    ///      Relaunch ceilings: seeds ≤ 500, team wallets ≤ 1, invites ≤ 100 per wallet, hop-2
    ///      placements ≤ 500.
    function _build(uint256 seeds, uint256 teams, uint256 invites, uint256 ltHop2, uint256 hop0Amt)
        internal returns (ArmadaCrowdfund cf)
    {
        cf = _buildTree(seeds, teams, invites, ltHop2);
        for (uint256 i = 0; i < seeds; i++) _commitAs(cf, _seedAddr(i), 0, hop0Amt);
        for (uint256 i = 0; i < teams; i++) _commitAs(cf, _teamAddr(i), 1, MIN_COMMIT);
        for (uint256 i = 0; i < invites + ltHop2; i++) _commitAs(cf, _hop2Addr(i), 2, MIN_COMMIT);
    }

    /// @dev Build the tree only — whitelist every node, NO commits. Isolates the per-node cost of
    ///      iterating an invited-but-uncommitted node (2 cold SLOADs → skip).
    function _buildTree(uint256 seeds, uint256 teams, uint256 invites, uint256 ltHop2)
        internal returns (ArmadaCrowdfund cf)
    {
        require(seeds <= 500, "seed cap");
        require(teams <= 1, "hop-1 LT budget");
        require(invites <= teams * 100, "team-wallet invite budget");
        require(ltHop2 <= 500, "hop-2 LT budget");

        cf = _deploy();

        if (seeds > 0) {
            address[] memory s_ = new address[](seeds);
            for (uint256 i = 0; i < seeds; i++) s_[i] = _seedAddr(i);
            cf.addSeeds(s_);
        }
        for (uint256 w = 0; w < teams; w++) cf.launchTeamInvite(_teamAddr(w), 0);
        for (uint256 i = 0; i < invites; i++) {
            vm.prank(_teamAddr(i / 100));
            cf.invite(_hop2Addr(i), 1);
        }
        for (uint256 i = 0; i < ltHop2; i++) cf.launchTeamInvite(_hop2Addr(invites + i), 1);
    }

    /// @dev Refund-path tree: MIN_COMMIT everywhere (capped demand << MIN_SALE). Iteration cost is
    ///      identical to the success path; this isolates the loop cost cheaply.
    function _buildRefund(uint256 seeds, uint256 teams, uint256 invites, uint256 ltHop2)
        internal returns (ArmadaCrowdfund cf)
    {
        return _build(seeds, teams, invites, ltHop2, MIN_COMMIT);
    }

    function _measure(ArmadaCrowdfund cf) internal returns (uint256 gasUsed) {
        vm.warp(cf.windowEnd() + 1);
        // Model a real transaction's first-touch storage: reset warm slots to cold.
        vm.cool(address(cf));
        vm.cool(address(usdc));
        uint256 gasBefore = gasleft();
        cf.finalize();
        gasUsed = gasBefore - gasleft();
    }

    function _report(string memory label, uint256 nodes, uint256 gasUsed) internal {
        emit log_named_uint(string.concat(label, " nodes"), nodes);
        emit log_named_uint(string.concat(label, " gas  "), gasUsed);
        emit log_named_uint(string.concat(label, " pctCap x100"), gasUsed * 10000 / TX_GAS_CAP);
        emit log_named_string(
            string.concat(label, " under 2^24?"),
            gasUsed <= TX_GAS_CAP ? "YES" : "NO - finalize() UNSUBMITTABLE"
        );
    }

    // ---- Cold gas profile at reachable node counts (the budgets bound the tree at 1,101). ----
    function test_cold_0500_refund() public { ArmadaCrowdfund cf = _buildRefund(300, 1, 100, 99);  _report(" 500(refund)",  500, _measure(cf)); }
    function test_cold_1000_refund() public { ArmadaCrowdfund cf = _buildRefund(500, 1, 100, 399); _report("1000(refund)", 1000, _measure(cf)); }

    // ---- GUARD: at the structural max, cold one-shot finalize() must stay under 2^24.
    //      Regression tripwire — fails if per-node cost or fixed overhead ever rises past the cap.
    //      Refund path (lower bound of the two).
    function test_cold_cap_guard_refund() public {
        ArmadaCrowdfund cf = _buildRefund(500, 1, 100, 500);
        assertEq(cf.getParticipantCount(), STRUCTURAL_MAX, "build must equal the structural max");
        uint256 g = _measure(cf);
        _report("MAX(refund)", cf.getParticipantCount(), g);
        assertLt(g, TX_GAS_CAP, "finalize() at structural max exceeds 2^24");
    }

    // ---- GUARD: success path at the structural max — the case that matters (a successful raise
    //      distributing ARM and paying the team in one finalize() tx). 500 seeds @ $100k
    //      oversubscribe the $1.8M sale.
    function test_cold_cap_guard_success() public {
        ArmadaCrowdfund cf = _build(500, 1, 100, 500, 100_000 * 1e6);
        assertEq(cf.getParticipantCount(), STRUCTURAL_MAX, "build must equal the structural max");
        uint256 g = _measure(cf);
        _report("MAX(success)", cf.getParticipantCount(), g);
        assertFalse(cf.refundMode(), "sale unexpectedly entered refund mode");
        assertLt(g, TX_GAS_CAP, "finalize() at structural max (success) exceeds 2^24");
    }

    // ---- Whitelist-only at the structural max: nodes invited, ZERO commits. Isolates the cost of
    //      iterating invited-but-uncommitted nodes (2 cold SLOADs each → `continue`); shows
    //      iteration cost is driven by WHITELIST count, not commit count. Zero demand → refund mode.
    function test_cold_cap_no_commits() public {
        ArmadaCrowdfund cf = _buildTree(500, 1, 100, 500);
        assertEq(cf.getParticipantCount(), STRUCTURAL_MAX, "build must equal the structural max");
        _report("MAX(whitelist,0-commit)", cf.getParticipantCount(), _measure(cf));
        assertTrue(cf.refundMode(), "zero demand should refund");
    }
}

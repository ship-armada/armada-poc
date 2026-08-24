// ABOUTME: Cold-storage gas profile of ArmadaCrowdfund.finalize() at the July-2026 structural max.
// ABOUTME: Uses vm.cool() to model a real tx's first-touch SLOADs vs the warm in-test measurement.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Cold-storage finalize() gas profile + the regression guard that one-shot finalize() at
///         the MAX_FINALIZE_NODES cap stays under the EIP-7825 per-tx gas cap (16,777,216 = 2^24).
///         Method (ported from the closed spike PR #266): vm.cool() before finalize() so first-touch
///         SLOADs are cold — a real transaction is its own tx and nothing is pre-warmed. Contrast the
///         merged CrowdfundFinalizeGas.t.sol, which measures WARM slots (pre-warmed by _populate in
///         the same test tx) and so understates real finalize() gas by ~3.6x.
///
///         Historical, now unreachable because MAX_FINALIZE_NODES bounds the tree at 1,800: at the
///         2,220-node structural max, cold one-shot finalize() was ~18.6M gas (success) — OVER the
///         2^24 cap. That finding motivated the cap; this suite profiles reachable counts (≤1,800)
///         and asserts the cap keeps finalize() submittable.
contract CrowdfundFinalizeGasColdTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant TX_GAS_CAP = 16_777_216; // EIP-7825 per-tx cap (2^24)

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
    function _hop1Addr(uint256 i) internal pure returns (address) { return address(uint160(0x20000000 + i)); }
    function _hop2Addr(uint256 i) internal pure returns (address) { return address(uint160(0x30000000 + i)); }

    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(cf), amount);
        vm.prank(who);
        cf.commit(hop, amount);
    }

    /// @dev Build the invite tree for (h0, h1, h2) nodes. Commit amounts are supplied per hop so
    ///      the same tree can drive either the refund path ($10 everywhere) or the success path.
    ///      July-2026 structural ceilings: h0 ≤ 180, h1 ≤ 3*h0 + 100, h2 ≤ 2*h1 + 120.
    function _build(
        uint256 h0,
        uint256 h1,
        uint256 h2,
        uint256 hop0Amt,
        uint256 hop1RealCount,
        uint256 hop1RealAmt
    ) internal returns (ArmadaCrowdfund cf) {
        cf = _buildTree(h0, h1, h2);

        // commits: hop-0 at hop0Amt; first hop1RealCount hop-1 nodes at hop1RealAmt, rest $10;
        // all hop-2 at $10. Every node commits > 0 so the iteration body runs for it.
        uint256 dust = 10 * 1e6;
        for (uint256 i = 0; i < h0; i++) _commitAs(cf, _seedAddr(i), 0, hop0Amt);
        for (uint256 i = 0; i < h1; i++) _commitAs(cf, _hop1Addr(i), 1, i < hop1RealCount ? hop1RealAmt : dust);
        for (uint256 i = 0; i < h2; i++) _commitAs(cf, _hop2Addr(i), 2, dust);
    }

    /// @dev Build the invite tree only — whitelist seeds/invitees, NO commits. Isolates the
    ///      per-node cost of iterating an invited-but-uncommitted node (2 cold SLOADs → skip).
    function _buildTree(uint256 h0, uint256 h1, uint256 h2) internal returns (ArmadaCrowdfund cf) {
        require(h0 <= 180, "h0 cap");
        require(h1 <= 3 * h0 + 100, "h1 cap");
        require(h2 <= 2 * h1 + 120, "h2 cap");

        cf = _deploy();

        // hop-0 seeds
        if (h0 > 0) {
            address[] memory seeds = new address[](h0);
            for (uint256 i = 0; i < h0; i++) seeds[i] = _seedAddr(i);
            cf.addSeeds(seeds);
        }

        // hop-1: seeds invite up to 3*h0, remainder via launch team (≤ 100)
        uint256 hop1ViaSeeds = h1 > 3 * h0 ? 3 * h0 : h1;
        uint256 hop1ViaLT = h1 - hop1ViaSeeds;
        require(hop1ViaLT <= 100, "hop1 LT budget");
        for (uint256 i = 0; i < hop1ViaSeeds; i++) {
            vm.prank(_seedAddr(i / 3));
            cf.invite(_hop1Addr(i), 0);
        }
        for (uint256 i = 0; i < hop1ViaLT; i++) {
            cf.launchTeamInvite(_hop1Addr(hop1ViaSeeds + i), 0);
        }

        // hop-2: hop-1 nodes invite up to 2 each, remainder via launch team (≤ 120)
        uint256 hop2ViaHop1 = h2 > 2 * h1 ? 2 * h1 : h2;
        uint256 hop2ViaLT = h2 - hop2ViaHop1;
        require(hop2ViaLT <= 120, "hop2 LT budget");
        for (uint256 i = 0; i < hop2ViaHop1; i++) {
            vm.prank(_hop1Addr(i / 2));
            cf.invite(_hop2Addr(i), 1);
        }
        for (uint256 i = 0; i < hop2ViaLT; i++) {
            cf.launchTeamInvite(_hop2Addr(hop2ViaHop1 + i), 1);
        }
    }

    /// @dev Refund-path tree: $10 everywhere (capped demand << MIN_SALE). Iteration cost is
    ///      identical to the success path; this isolates the loop cost cheaply.
    function _buildRefund(uint256 h0, uint256 h1, uint256 h2) internal returns (ArmadaCrowdfund cf) {
        return _build(h0, h1, h2, 10 * 1e6, 0, 0);
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

    // ---- Cold gas profile at reachable node counts (the guard bounds the tree at 1,800). ----
    function test_cold_0500_refund() public { ArmadaCrowdfund cf = _buildRefund(180, 320, 0);   _report(" 500(refund)",  500, _measure(cf)); }
    function test_cold_1000_refund() public { ArmadaCrowdfund cf = _buildRefund(180, 540, 280); _report("1000(refund)", 1000, _measure(cf)); }
    function test_cold_1500_refund() public { ArmadaCrowdfund cf = _buildRefund(180, 640, 680); _report("1500(refund)", 1500, _measure(cf)); }

    // ---- GUARD: at the MAX_FINALIZE_NODES cap, cold one-shot finalize() must stay under 2^24.
    //      Regression tripwire — fails if per-node cost or fixed overhead ever rises past the cap.
    //      Refund path (lower bound of the two).
    function test_cold_cap_guard_refund() public {
        ArmadaCrowdfund cf = _buildRefund(180, 640, 980);
        assertEq(cf.getParticipantCount(), cf.MAX_FINALIZE_NODES(), "build must equal the node cap");
        uint256 g = _measure(cf);
        _report("CAP(refund)", cf.getParticipantCount(), g);
        assertLt(g, TX_GAS_CAP, "finalize() at node cap exceeds 2^24");
    }

    // ---- GUARD: success path at the cap — the case that matters (a successful raise distributing
    //      ARM in one finalize() tx). 180 seeds @ $15k + 40 hop-1 @ $4k clears MIN_SALE (expands to
    //      $1.8M; hop-0 $846k + hop-1 ~$166k + hop-2 dust > $1M).
    function test_cold_cap_guard_success() public {
        ArmadaCrowdfund cf = _build(180, 640, 980, 15_000 * 1e6, 40, 4_000 * 1e6);
        assertEq(cf.getParticipantCount(), cf.MAX_FINALIZE_NODES(), "build must equal the node cap");
        uint256 g = _measure(cf);
        _report("CAP(success)", cf.getParticipantCount(), g);
        assertFalse(cf.refundMode(), "sale unexpectedly entered refund mode");
        assertLt(g, TX_GAS_CAP, "finalize() at node cap (success) exceeds 2^24");
    }

    // ---- Whitelist-only at the cap: nodes invited, ZERO commits. Isolates the cost of iterating
    //      invited-but-uncommitted nodes (2 cold SLOADs each → `continue`); shows iteration cost is
    //      driven by WHITELIST count, not commit count. Zero demand → refund mode.
    function test_cold_cap_no_commits() public {
        ArmadaCrowdfund cf = _buildTree(180, 640, 980);
        assertEq(cf.getParticipantCount(), cf.MAX_FINALIZE_NODES(), "build must equal the node cap");
        _report("CAP(whitelist,0-commit)", cf.getParticipantCount(), _measure(cf));
        assertTrue(cf.refundMode(), "zero demand should refund");
    }
}

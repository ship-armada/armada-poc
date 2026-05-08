// ABOUTME: Empirical gas profile of ArmadaCrowdfund.finalize() at varying participantNodes counts.
// ABOUTME: Populates the contract to representative N values and measures actual finalize() gas.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract CrowdfundFinalizeGasTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;

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

    function _seedAddr(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000000 + i));
    }

    function _hop1Addr(uint256 i) internal pure returns (address) {
        return address(uint160(0x20000000 + i));
    }

    function _hop2Addr(uint256 i) internal pure returns (address) {
        return address(uint160(0x30000000 + i));
    }

    function _commitAs(ArmadaCrowdfund cf, address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(cf), amount);
        vm.prank(who);
        cf.commit(hop, amount);
    }

    /// @notice Build a crowdfund with the requested counts of (hop0, hop1, hop2) nodes,
    ///         each with a $10 commitment so the iteration loop hits the full body
    ///         (committed > 0 → cap calc + accumulate). Refund mode is fine for gas
    ///         profiling — the iteration cost is identical.
    /// @dev Caller must respect the structural ceilings:
    ///        h0 ≤ 160
    ///        h1 ≤ 3*h0 + 60
    ///        h2 ≤ 2*h1 + 60
    function _populate(uint256 h0, uint256 h1, uint256 h2) internal returns (ArmadaCrowdfund cf) {
        require(h0 <= 160, "h0 cap");
        require(h1 <= 3 * h0 + 60, "h1 cap");
        require(h2 <= 2 * h1 + 60, "h2 cap");

        cf = _deploy();

        // ---- hop-0: seeds (must be done in week 1)
        if (h0 > 0) {
            address[] memory seeds = new address[](h0);
            for (uint256 i = 0; i < h0; i++) {
                seeds[i] = _seedAddr(i);
            }
            cf.addSeeds(seeds);
        }

        // ---- hop-1: route the first min(h1, 3*h0) through seeds, the rest via launch team (max 60)
        uint256 hop1ViaSeeds = h1 > 3 * h0 ? 3 * h0 : h1;
        uint256 hop1ViaLT = h1 - hop1ViaSeeds;
        require(hop1ViaLT <= 60, "hop1 LT budget");

        // seeds invite hop-1: each seed sends up to 3 invites
        for (uint256 i = 0; i < hop1ViaSeeds; i++) {
            address inviter = _seedAddr(i / 3);
            address invitee = _hop1Addr(i);
            vm.prank(inviter);
            cf.invite(invitee, 0);
        }
        // launch-team invites for hop-1 (week 1 only, but we're at t=windowStart so OK)
        for (uint256 i = 0; i < hop1ViaLT; i++) {
            address invitee = _hop1Addr(hop1ViaSeeds + i);
            cf.launchTeamInvite(invitee, 0);
        }

        // ---- hop-2: route through hop-1 nodes, then launch team
        uint256 hop2ViaHop1 = h2 > 2 * h1 ? 2 * h1 : h2;
        uint256 hop2ViaLT = h2 - hop2ViaHop1;
        require(hop2ViaLT <= 60, "hop2 LT budget");

        for (uint256 i = 0; i < hop2ViaHop1; i++) {
            address inviter = _hop1Addr(i / 2);
            address invitee = _hop2Addr(i);
            vm.prank(inviter);
            cf.invite(invitee, 1);
        }
        for (uint256 i = 0; i < hop2ViaLT; i++) {
            address invitee = _hop2Addr(hop2ViaHop1 + i);
            cf.launchTeamInvite(invitee, 1);
        }

        // ---- commits: $10 each (MIN_COMMIT) so committed > 0
        uint256 amt = 10 * 1e6;
        for (uint256 i = 0; i < h0; i++) _commitAs(cf, _seedAddr(i), 0, amt);
        for (uint256 i = 0; i < h1; i++) _commitAs(cf, _hop1Addr(i), 1, amt);
        for (uint256 i = 0; i < h2; i++) _commitAs(cf, _hop2Addr(i), 2, amt);

        return cf;
    }

    function _measureFinalize(ArmadaCrowdfund cf) internal returns (uint256 gasUsed) {
        vm.warp(cf.windowEnd() + 1);
        // Mark the crowdfund (and USDC, for the success-path treasury transfer) as cold
        // so we model a real on-chain transaction's first-touch storage costs.
        vm.cool(address(cf));
        vm.cool(address(usdc));
        uint256 gasBefore = gasleft();
        cf.finalize();
        uint256 gasAfter = gasleft();
        gasUsed = gasBefore - gasAfter;
    }

    /// @notice Like _populate but commits enough USDC at hop-0 to put the sale on the
    ///         success path (≥ MIN_SALE = $1M capped demand). All other hops commit
    ///         $10 each so the iteration body still runs for them.
    function _populateSuccessPath(uint256 h0, uint256 h1, uint256 h2) internal returns (ArmadaCrowdfund cf) {
        require(h0 >= 67, "need >=67 hop-0 nodes for $1M @ $15k");
        require(h0 <= 160, "h0 cap");
        require(h1 <= 3 * h0 + 60, "h1 cap");
        require(h2 <= 2 * h1 + 60, "h2 cap");

        cf = _deploy();

        if (h0 > 0) {
            address[] memory seeds = new address[](h0);
            for (uint256 i = 0; i < h0; i++) seeds[i] = _seedAddr(i);
            cf.addSeeds(seeds);
        }

        uint256 hop1ViaSeeds = h1 > 3 * h0 ? 3 * h0 : h1;
        uint256 hop1ViaLT = h1 - hop1ViaSeeds;
        for (uint256 i = 0; i < hop1ViaSeeds; i++) {
            vm.prank(_seedAddr(i / 3));
            cf.invite(_hop1Addr(i), 0);
        }
        for (uint256 i = 0; i < hop1ViaLT; i++) {
            cf.launchTeamInvite(_hop1Addr(hop1ViaSeeds + i), 0);
        }

        uint256 hop2ViaHop1 = h2 > 2 * h1 ? 2 * h1 : h2;
        uint256 hop2ViaLT = h2 - hop2ViaHop1;
        for (uint256 i = 0; i < hop2ViaHop1; i++) {
            vm.prank(_hop1Addr(i / 2));
            cf.invite(_hop2Addr(i), 1);
        }
        for (uint256 i = 0; i < hop2ViaLT; i++) {
            cf.launchTeamInvite(_hop2Addr(hop2ViaHop1 + i), 1);
        }

        // hop-0 commits at full cap ($15k each) so cappedDemand >= h0 * $15k. With h0>=67, that's ≥ $1.005M.
        for (uint256 i = 0; i < h0; i++) _commitAs(cf, _seedAddr(i), 0, 15_000 * 1e6);
        for (uint256 i = 0; i < h1; i++) _commitAs(cf, _hop1Addr(i), 1, 10 * 1e6);
        for (uint256 i = 0; i < h2; i++) _commitAs(cf, _hop2Addr(i), 2, 10 * 1e6);

        return cf;
    }

    // ============ Gas measurements ============

    function test_gas_100nodes() public {
        ArmadaCrowdfund cf = _populate(100, 0, 0);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=100        finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 100);
    }

    function test_gas_500nodes() public {
        // 100 hop-0 seeds, 300 hop-1 (3 per seed), 100 hop-2 (1 per hop-1, only need 100)
        ArmadaCrowdfund cf = _populate(100, 300, 100);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=500        finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 500);
    }

    function test_gas_1000nodes() public {
        // 160 + 480 + 360
        ArmadaCrowdfund cf = _populate(160, 480, 360);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=1000       finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 1000);
    }

    function test_gas_1500nodes() public {
        // 160 + 480 + 860 (max hop2 via hop1 = 960, +60 LT = 1020 max; we use 860)
        ArmadaCrowdfund cf = _populate(160, 480, 860);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=1500       finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 1500);
    }

    function test_gas_1780nodes_maxRegular() public {
        // No launch-team budget used at hop-1 (skip 60), full hop-2 fanout from 480 hop-1 nodes
        // 160 + 480 + (2*480 + 60) = 160 + 480 + 1020 = 1660. Use this as max-via-regular-paths.
        // Add 60 LT hop-1 = full structural max.
        // Here: 160 hop-0 + 480 hop-1 + 1140 hop-2 with no LT hop-1 = 1780.
        // (480 hop-1 × 2 = 960 hop-2 from invites + 60 LT hop-2 = 1020)
        ArmadaCrowdfund cf = _populate(160, 480, 1020);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=1660       finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 1660);
    }

    function test_gas_1840nodes_structuralMax() public {
        // Full structural max: 160 hop-0 + 540 hop-1 (480 from seeds + 60 LT) + 1140 hop-2 (1080 from hop-1 + 60 LT)
        ArmadaCrowdfund cf = _populate(160, 540, 1140);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=1840 (MAX) finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 1840);
    }

    // ============ Success-path measurement (extra state writes + treasury transfer) ============

    function test_gas_1840nodes_successPath() public {
        // 160 hop-0 × $15k = $2.4M cappedDemand → success path (above MIN_SALE & ELASTIC_TRIGGER)
        ArmadaCrowdfund cf = _populateSuccessPath(160, 540, 1140);
        uint256 gasUsed = _measureFinalize(cf);
        emit log_named_uint("nodes=1840 SUCCESS finalize gas", gasUsed);
        assertEq(cf.getParticipantCount(), 1840);
        assertFalse(cf.refundMode(), "should not be refund mode");
    }

    // ============ Multi-batch gas profile (resumable finalize fallback) ============
    //
    // WHY: Verifies the per-batch gas cost is bounded and predictable so operators
    // can choose maxIterations confidently in a real OOG scenario. Models the
    // worst-case cold-storage condition for the FIRST batch (sets up cursor +
    // accumulators); subsequent batches enjoy warm progress slots so per-iteration
    // gas converges to the original tight loop.

    /// @notice Single-batch consumes the same gas as one-shot finalize() at the
    ///         structural max. Confirms finalizeStep(MAX_INT) parity claim.
    function test_gas_1840_finalizeStep_singleHugeBatch() public {
        ArmadaCrowdfund cf = _populate(160, 540, 1140);
        vm.warp(cf.windowEnd() + 1);
        vm.cool(address(cf));
        vm.cool(address(usdc));
        uint256 gasBefore = gasleft();
        cf.finalizeStep(type(uint256).max);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("nodes=1840 finalizeStep(MAX) gas", gasUsed);
        assertFalse(cf.finalizeInProgress(), "completed");
    }

    /// @notice Profile a 100-node batch on a 1,840-node sale: shows the per-batch
    ///         cost an operator pays during a paginated recovery. WHY: 100 is the
    ///         "operationally trivial" batch size called out in the design doc.
    function test_gas_1840_batched_at100() public {
        ArmadaCrowdfund cf = _populate(160, 540, 1140);
        vm.warp(cf.windowEnd() + 1);
        vm.cool(address(cf));
        vm.cool(address(usdc));

        // First batch — bears cold-storage initialization cost
        uint256 gasBefore = gasleft();
        cf.finalizeStep(100);
        uint256 firstBatchGas = gasBefore - gasleft();
        emit log_named_uint("batch=100 first  (init cold)", firstBatchGas);

        // Mid batch — warm progress slots
        gasBefore = gasleft();
        cf.finalizeStep(100);
        uint256 midBatchGas = gasBefore - gasleft();
        emit log_named_uint("batch=100 mid    (warm)     ", midBatchGas);

        // Run remaining 16 batches to completion, summing total
        uint256 batchCount = 2;
        uint256 totalGas = firstBatchGas + midBatchGas;
        while (cf.finalizeInProgress()) {
            gasBefore = gasleft();
            cf.finalizeStep(100);
            totalGas += gasBefore - gasleft();
            batchCount++;
        }
        emit log_named_uint("batch=100 total batches", batchCount);
        emit log_named_uint("batch=100 total gas    ", totalGas);
    }

    /// @notice Profile a 250-node batch — the upper bound of the "trivially lands"
    ///         range from the design doc.
    function test_gas_1840_batched_at250() public {
        ArmadaCrowdfund cf = _populate(160, 540, 1140);
        vm.warp(cf.windowEnd() + 1);
        vm.cool(address(cf));
        vm.cool(address(usdc));

        uint256 gasBefore = gasleft();
        cf.finalizeStep(250);
        uint256 firstBatchGas = gasBefore - gasleft();
        emit log_named_uint("batch=250 first  (init cold)", firstBatchGas);

        gasBefore = gasleft();
        cf.finalizeStep(250);
        uint256 midBatchGas = gasBefore - gasleft();
        emit log_named_uint("batch=250 mid    (warm)     ", midBatchGas);

        uint256 batchCount = 2;
        uint256 totalGas = firstBatchGas + midBatchGas;
        while (cf.finalizeInProgress()) {
            gasBefore = gasleft();
            cf.finalizeStep(250);
            totalGas += gasBefore - gasleft();
            batchCount++;
        }
        emit log_named_uint("batch=250 total batches", batchCount);
        emit log_named_uint("batch=250 total gas    ", totalGas);
    }

    /// @notice Profile a 500-node batch — half-block-friendly even at congestion.
    function test_gas_1840_batched_at500() public {
        ArmadaCrowdfund cf = _populate(160, 540, 1140);
        vm.warp(cf.windowEnd() + 1);
        vm.cool(address(cf));
        vm.cool(address(usdc));

        uint256 batchCount;
        uint256 totalGas;
        while (cf.finalizeInProgress() || batchCount == 0) {
            uint256 gasBefore = gasleft();
            cf.finalizeStep(500);
            totalGas += gasBefore - gasleft();
            batchCount++;
        }
        emit log_named_uint("batch=500 total batches", batchCount);
        emit log_named_uint("batch=500 total gas    ", totalGas);
    }
}

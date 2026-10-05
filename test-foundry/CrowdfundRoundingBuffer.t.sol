// ABOUTME: Regression tests for the finalize() rounding-buffer dust bound (audit-71).
// ABOUTME: Verifies buffer = participantNodes.length is tight and refunds never run short.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract CrowdfundRoundingBufferTest is Test {
    ArmadaCrowdfund public crowdfund;
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
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            treasury,
            admin,
            admin,
            block.timestamp
        );

        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        address[] memory delegators = new address[](1);
        delegators[0] = address(crowdfund);
        armToken.initAuthorizedDelegators(delegators);

        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();
    }

    function _seed(uint256 i) internal pure returns (address) {
        return address(uint160(0x1000 + i));
    }

    function _hop1(uint256 i) internal pure returns (address) {
        return address(uint160(0x2000 + i));
    }

    // WHY: audit-71 — the original buffer was `participantNodes.length * NUM_HOPS`,
    // which over-reserves by a factor of NUM_HOPS = 3 because each participant only
    // commits at one hop. The auditor's PoC uses 100 seeds at hop-0 plus enough
    // hop-1 demand to clear MIN_SALE; the allocations are integer-exact (zero
    // actual dust), so the entire buffer is stranded.
    // Post-fix: buffer = participantNodes.length; the (NUM_HOPS - 1) overage is
    // recovered to treasury. Confirms the fix delivers the recovered amount.
    function test_buffer_recoversOverReservation_integerExactAllocations() public {
        uint256 SEED_COUNT = 100;
        uint256 HOP1_COUNT = 39;
        uint256 SEED_COMMIT = 15_000 * 1e6;
        uint256 HOP1_COMMIT = 4_000 * 1e6;

        address[] memory seeds = new address[](SEED_COUNT);
        for (uint256 i = 0; i < SEED_COUNT; i++) seeds[i] = _seed(i);
        crowdfund.addSeeds(seeds);

        for (uint256 i = 0; i < SEED_COUNT; i++) {
            usdc.mint(seeds[i], SEED_COMMIT);
            vm.startPrank(seeds[i]);
            usdc.approve(address(crowdfund), SEED_COMMIT);
            crowdfund.commit(0, SEED_COMMIT);
            vm.stopPrank();
        }

        for (uint256 i = 0; i < HOP1_COUNT; i++) {
            address hop1 = _hop1(i);
            vm.prank(seeds[i % SEED_COUNT]);
            crowdfund.invite(hop1, 0);
            usdc.mint(hop1, HOP1_COMMIT);
            vm.startPrank(hop1);
            usdc.approve(address(crowdfund), HOP1_COMMIT);
            crowdfund.commit(1, HOP1_COMMIT);
            vm.stopPrank();
        }

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode(), "should be success-path");

        // The expanded H0 ceiling is $846K; each of 100 seeds receives $8,460.
        // Hop-1 demand receives its full $156K, so all allocations are exact.
        uint256 allocPerSeed = 8_460 * 1e6;
        uint256 totalAlloc = SEED_COUNT * allocPerSeed + HOP1_COUNT * HOP1_COMMIT;
        uint256 buffer = SEED_COUNT + HOP1_COUNT;  // post-fix: participantNodes.length

        assertEq(crowdfund.totalAllocatedUsdc(), totalAlloc, "alloc total");
        // Treasury receives totalAlloc - buffer.
        // Pre-fix this was totalAlloc - SEED_COUNT * NUM_HOPS (3x over-reserved).
        assertEq(usdc.balanceOf(treasury), totalAlloc - buffer, "treasury proceeds");

        // All claims must succeed (contract never runs short).
        for (uint256 i = 0; i < SEED_COUNT; i++) {
            vm.prank(seeds[i]);
            crowdfund.claim(_seed(i));
        }
        for (uint256 i = 0; i < HOP1_COUNT; i++) {
            vm.prank(_hop1(i));
            crowdfund.claim(_hop1(i));
        }

        // After all claims, the contract holds the unused buffer (integer-exact
        // allocs produced zero actual dust, so the full buffer remains as
        // unrecoverable dust per the settlement identity).
        assertEq(usdc.balanceOf(address(crowdfund)), buffer, "contract dust = unused buffer");
    }

    // WHY: audit-71 — the bound `dust < participantNodes.length` is mathematically
    // tight (each oversubscribed-hop floor division loses < 1 unit; sum across N
    // committers is in [0, N)). This test pins the bound by constructing
    // non-integer-exact allocations and verifying:
    //   1. Actual dust < participantNodes.length (bound holds)
    //   2. All refunds succeed (contract does not run short)
    //   3. Settlement identity: treasuryReceived + contractDust + sumRefunds == totalCommitted
    function test_buffer_refundsSucceed_underWorstCaseDust() public {
        // 110 seeds each at the $15k hop-0 cap plus 39 full hop-1 commitments.
        // Expansion sets the H0 ceiling to $846K. The H0 pro-rata allocation is
        // floor(15000 * 846000 / 1650000) = 7690.909... USDC, leaving 100 raw
        // USDC units of dust across 110 seed claims. The 39 H1 claims are exact.
        // The bound under test remains dust < participantNodes.length.
        uint256 SEED_COUNT = 110;
        uint256 HOP1_COUNT = 39;
        uint256 SEED_COMMIT = 15_000 * 1e6;
        uint256 HOP1_COMMIT = 4_000 * 1e6;
        address[] memory seeds = new address[](SEED_COUNT);
        for (uint256 i = 0; i < SEED_COUNT; i++) seeds[i] = _seed(i);
        crowdfund.addSeeds(seeds);

        uint256 totalCommitted = 0;
        for (uint256 i = 0; i < SEED_COUNT; i++) {
            usdc.mint(seeds[i], SEED_COMMIT);
            vm.startPrank(seeds[i]);
            usdc.approve(address(crowdfund), SEED_COMMIT);
            crowdfund.commit(0, SEED_COMMIT);
            vm.stopPrank();
            totalCommitted += SEED_COMMIT;
        }

        for (uint256 i = 0; i < HOP1_COUNT; i++) {
            address hop1 = _hop1(i);
            vm.prank(seeds[i % SEED_COUNT]);
            crowdfund.invite(hop1, 0);
            usdc.mint(hop1, HOP1_COMMIT);
            vm.startPrank(hop1);
            usdc.approve(address(crowdfund), HOP1_COMMIT);
            crowdfund.commit(1, HOP1_COMMIT);
            vm.stopPrank();
            totalCommitted += HOP1_COMMIT;
        }

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode(), "should be success-path");

        uint256 totalAlloc = crowdfund.totalAllocatedUsdc();
        uint256 treasuryReceived = usdc.balanceOf(treasury);

        // Buffer = participantNodes.length. For tiny
        // sales the saturating ternary in finalize() floors at zero, but here the
        // alloc is large so we expect the simple subtraction.
        uint256 participantCount = SEED_COUNT + HOP1_COUNT;
        assertEq(treasuryReceived, totalAlloc - participantCount, "treasury = totalAlloc - buffer");

        // Settlement identity sanity (pre-claims): contract holds totalCommitted - treasury.
        assertEq(
            usdc.balanceOf(address(crowdfund)),
            totalCommitted - treasuryReceived,
            "contract balance = totalCommitted - treasury (pre-claims)"
        );

        // All claims must succeed; sum the actually-distributed refunds.
        uint256 sumRefunds = 0;
        for (uint256 i = 0; i < SEED_COUNT; i++) {
            uint256 refundBefore = usdc.balanceOf(seeds[i]);
            vm.prank(seeds[i]);
            crowdfund.claim(_seed(i));
            sumRefunds += usdc.balanceOf(seeds[i]) - refundBefore;
        }
        for (uint256 i = 0; i < HOP1_COUNT; i++) {
            address hop1 = _hop1(i);
            uint256 refundBefore = usdc.balanceOf(hop1);
            vm.prank(hop1);
            crowdfund.claim(hop1);
            sumRefunds += usdc.balanceOf(hop1) - refundBefore;
        }

        // Settlement identity holds: treasuryReceived + contractDust + sumRefunds == totalCommitted
        uint256 contractDust = usdc.balanceOf(address(crowdfund));
        assertEq(
            treasuryReceived + contractDust + sumRefunds,
            totalCommitted,
            "settlement identity"
        );

        // Bound check: contractDust ≤ participantNodes.length. The bound is tight —
        // dust < N strictly, so contractDust must be < SEED_COUNT (could equal
        // SEED_COUNT - 1 in the absolute-worst-case alignment, but never reach SEED_COUNT
        // because actual_dust < N). After claims, contractDust = buffer - actual_dust ≥ 1.
        assertLe(contractDust, participantCount, "contract dust within buffer bound");
        assertGt(contractDust, 0, "buffer never fully consumed (dust < N strictly)");
    }
}

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

    // WHY: audit-71 — the original buffer was `participantNodes.length * NUM_HOPS`,
    // which over-reserves by a factor of NUM_HOPS = 3 because each participant only
    // commits at one hop. The auditor's PoC: 100 seeds each commit $15k at hop-0,
    // alloc is integer-exact (zero actual dust), so the entire buffer is stranded.
    // Post-fix: buffer = participantNodes.length; the (NUM_HOPS - 1) overage is
    // recovered to treasury. Confirms the fix delivers the recovered amount.
    function test_buffer_recoversOverReservation_integerExactAllocations() public {
        uint256 SEED_COUNT = 100;
        uint256 SEED_COMMIT = 15_000 * 1e6;

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

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode(), "should be success-path");

        // Per-seed alloc: (15000 * 1197000) / 1500000 = 11970 (integer-exact, zero dust)
        uint256 allocPerSeed = 11_970 * 1e6;
        uint256 totalAlloc = SEED_COUNT * allocPerSeed;
        uint256 buffer = SEED_COUNT;  // post-fix: participantNodes.length

        assertEq(crowdfund.totalAllocatedUsdc(), totalAlloc, "alloc total");
        // Treasury receives totalAlloc - buffer.
        // Pre-fix this was totalAlloc - SEED_COUNT * NUM_HOPS (3x over-reserved).
        assertEq(usdc.balanceOf(treasury), totalAlloc - buffer, "treasury proceeds");

        // All claims must succeed (contract never runs short).
        for (uint256 i = 0; i < SEED_COUNT; i++) {
            vm.prank(seeds[i]);
            crowdfund.claim(_seed(i));
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
        // 110 seeds each at the $15k hop-0 cap — total $1.65M, exceeds the
        // $1.5M ELASTIC_TRIGGER so expansion to MAX_SALE fires (hop-0 ceiling
        // becomes $1,197,000). With 110 committers and demand $1,650,000:
        //   per-seed alloc = floor(15000 * 1_197_000 / 1_650_000) = floor(10881.81…) = 10881 USDC
        //   sum across 110 = 1,196,910 USDC
        //   total dust = 1_197_000 - 1_196_910 = 90 USDC (in raw units of 1)
        // The bound under test: dust < participantNodes.length (90 < 110). The
        // contract retains buffer - dust = 20 raw units after all claims, the
        // unrecoverable dust portion the spec acknowledges.
        uint256 SEED_COUNT = 110;
        uint256 SEED_COMMIT = 15_000 * 1e6;
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

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode(), "should be success-path");

        uint256 totalAlloc = crowdfund.totalAllocatedUsdc();
        uint256 treasuryReceived = usdc.balanceOf(treasury);

        // Buffer = participantNodes.length = SEED_COUNT (no invites). For tiny
        // sales the saturating ternary in finalize() floors at zero, but here the
        // alloc is large so we expect the simple subtraction.
        assertEq(treasuryReceived, totalAlloc - SEED_COUNT, "treasury = totalAlloc - buffer");

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
        assertLe(contractDust, SEED_COUNT, "contract dust within buffer bound");
        assertGt(contractDust, 0, "buffer never fully consumed (dust < N strictly)");
    }
}

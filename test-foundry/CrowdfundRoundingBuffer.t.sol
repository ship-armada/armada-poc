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

    uint256 constant ARM_FUNDING = 1_500_000 * 1e18;

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

    function _hop2(uint256 i) internal pure returns (address) {
        return address(uint160(0x2000 + i));
    }

    function _commitAs(address who, uint8 hop, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(crowdfund), amount);
        crowdfund.commit(hop, amount);
        vm.stopPrank();
    }

    // WHY: audit-71 — the original buffer was `participantNodes.length * NUM_HOPS`,
    // which over-reserves by a factor of NUM_HOPS = 3 because each participant only
    // commits at one hop. With integer-exact allocations (zero actual dust) the entire
    // buffer is stranded, so this pins that the buffer is exactly participantNodes.length.
    // Scenario: 20 seeds × $150K = $3M of hop-0 demand against the $1.5M sale → each seed is
    // pro-rated to exactly $75K; 10 launch-team hop-2 placements at $10K are crowded out
    // (allocated 0, refunded in full). Both are integer-exact.
    function test_buffer_recoversOverReservation_integerExactAllocations() public {
        uint256 SEED_COUNT = 20;
        uint256 HOP2_COUNT = 10;
        uint256 SEED_COMMIT = 150_000 * 1e6;
        uint256 HOP2_COMMIT = 10_000 * 1e6;

        address[] memory seeds = new address[](SEED_COUNT);
        for (uint256 i = 0; i < SEED_COUNT; i++) seeds[i] = _seed(i);
        crowdfund.addSeeds(seeds);
        for (uint256 i = 0; i < SEED_COUNT; i++) _commitAs(seeds[i], 0, SEED_COMMIT);

        for (uint256 i = 0; i < HOP2_COUNT; i++) {
            crowdfund.launchTeamInvite(_hop2(i), 1);
            _commitAs(_hop2(i), 2, HOP2_COMMIT);
        }

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode(), "should be success-path");

        uint256 allocPerSeed = 75_000 * 1e6;
        uint256 totalAlloc = SEED_COUNT * allocPerSeed;
        uint256 buffer = SEED_COUNT + HOP2_COUNT;  // post-fix: participantNodes.length

        assertEq(crowdfund.totalAllocatedUsdc(), totalAlloc, "alloc total");
        // Treasury receives totalAlloc - buffer.
        // Pre-fix this was totalAlloc - nodes * NUM_HOPS (3x over-reserved).
        assertEq(usdc.balanceOf(treasury), totalAlloc - buffer, "treasury proceeds");

        // All claims must succeed (contract never runs short).
        for (uint256 i = 0; i < SEED_COUNT; i++) {
            vm.prank(seeds[i]);
            crowdfund.claim(_seed(i));
        }
        for (uint256 i = 0; i < HOP2_COUNT; i++) {
            vm.prank(_hop2(i));
            crowdfund.claim(address(0)); // refund only: no ARM, no delegate needed
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
        // 11 seeds at the $150K cap = $1.65M against the $1.5M sale. Each seed's allocation is
        // floor(150000 * 1500000 / 1650000) = 136363.636... USDC, leaving 7 raw USDC units of
        // dust across the 11 seed claims. 39 launch-team hop-2 placements at $10K are crowded
        // out (exact: 0 allocated, full refund). The bound under test is dust < nodes.
        uint256 SEED_COUNT = 11;
        uint256 HOP2_COUNT = 39;
        uint256 SEED_COMMIT = 150_000 * 1e6;
        uint256 HOP2_COMMIT = 10_000 * 1e6;
        address[] memory seeds = new address[](SEED_COUNT);
        for (uint256 i = 0; i < SEED_COUNT; i++) seeds[i] = _seed(i);
        crowdfund.addSeeds(seeds);

        uint256 totalCommitted = 0;
        for (uint256 i = 0; i < SEED_COUNT; i++) {
            _commitAs(seeds[i], 0, SEED_COMMIT);
            totalCommitted += SEED_COMMIT;
        }
        for (uint256 i = 0; i < HOP2_COUNT; i++) {
            crowdfund.launchTeamInvite(_hop2(i), 1);
            _commitAs(_hop2(i), 2, HOP2_COMMIT);
            totalCommitted += HOP2_COMMIT;
        }

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertFalse(crowdfund.refundMode(), "should be success-path");

        uint256 totalAlloc = crowdfund.totalAllocatedUsdc();
        uint256 treasuryReceived = usdc.balanceOf(treasury);

        // Buffer = participantNodes.length. For tiny
        // sales the saturating ternary in finalize() floors at zero, but here the
        // alloc is large so we expect the simple subtraction.
        uint256 participantCount = SEED_COUNT + HOP2_COUNT;
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
        for (uint256 i = 0; i < HOP2_COUNT; i++) {
            address hop2 = _hop2(i);
            uint256 refundBefore = usdc.balanceOf(hop2);
            vm.prank(hop2);
            crowdfund.claim(address(0));
            sumRefunds += usdc.balanceOf(hop2) - refundBefore;
        }

        // Settlement identity holds: treasuryReceived + contractDust + sumRefunds == totalCommitted
        uint256 contractDust = usdc.balanceOf(address(crowdfund));
        assertEq(
            treasuryReceived + contractDust + sumRefunds,
            totalCommitted,
            "settlement identity"
        );

        // Bound check: contractDust ≤ participantNodes.length. After claims,
        // contractDust = buffer - actual_dust, and actual_dust < N strictly, so ≥ 1 remains.
        assertLe(contractDust, participantCount, "contract dust within buffer bound");
        assertGt(contractDust, 0, "buffer never fully consumed (dust < N strictly)");
        assertEq(contractDust, participantCount - 7, "7 units of rounding dust paid out of the buffer");
    }
}

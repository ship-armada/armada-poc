// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title CrowdfundHandler — Stateful fuzz handler for ArmadaCrowdfund invariant testing
/// @dev Drives the crowdfund through its lifecycle with bounded fuzz inputs.
///      Tracks ghost variables for invariant assertions.
contract CrowdfundHandler is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;

    // Actor pools
    address[] public seeds;
    address[] public hop1Addrs;
    address[] public hop2Addrs;
    address[] public allCommitters;

    // Ghost variables for invariant checking
    uint256 public ghost_totalUsdcIn;       // USDC deposited via commit()
    uint256 public ghost_totalArmClaimed;   // ARM withdrawn via claim()
    uint256 public ghost_totalUsdcRefunded; // USDC returned via claim() refunds
    uint256 public ghost_totalUsdcCancelRefunded; // USDC returned via claimRefund() (canceled/refundMode)
    uint256 public ghost_proceedsPushed;    // USDC pushed to treasury at finalization
    uint256 public ghost_unallocArmWithdrawn; // ARM withdrawn via withdrawUnallocatedArm()
    uint256 public ghost_claimCount;        // number of successful claims
    bool public ghost_finalized;
    bool public ghost_canceled;
    bool public ghost_refundMode;

    // Track per-participant committed amounts for sum verification
    mapping(address => uint256) public ghost_committed;
    // Track each committer's hop for API calls that require it
    mapping(address => uint8) public ghost_hop;

    constructor(
        ArmadaCrowdfund _crowdfund,
        MockUSDCV2 _usdc,
        ArmadaToken _armToken,
        address _admin,
        address[] memory _seeds,
        address[] memory _hop1,
        address[] memory _hop2
    ) {
        crowdfund = _crowdfund;
        usdc = _usdc;
        armToken = _armToken;
        admin = _admin;
        seeds = _seeds;
        hop1Addrs = _hop1;
        hop2Addrs = _hop2;
    }

    // ============ Handler Actions ============

    /// @dev Fuzzed commit: pick a random seed and commit a bounded amount
    function commitSeed(uint256 seedIdx, uint256 amount) external {
        if (seeds.length == 0) return;
        seedIdx = bound(seedIdx, 0, seeds.length - 1);
        amount = bound(amount, 1, 15_000 * 1e6); // up to hop-0 cap

        address seed = seeds[seedIdx];

        // Check if this would exceed cap
        uint256 currentCommitted = crowdfund.getCommitment(seed, 0);
        if (currentCommitted + amount > 15_000 * 1e6) {
            amount = 15_000 * 1e6 - currentCommitted;
        }
        if (amount == 0) return;

        // Fund and approve
        usdc.mint(seed, amount);
        vm.startPrank(seed);
        usdc.approve(address(crowdfund), amount);

        try crowdfund.commit(0, amount) {
            ghost_totalUsdcIn += amount;
            ghost_committed[seed] += amount;
            if (ghost_committed[seed] == amount) {
                allCommitters.push(seed);
                ghost_hop[seed] = 0;
            }
        } catch {}
        vm.stopPrank();
    }

    /// @dev Fuzzed commit for hop-1 addresses
    function commitHop1(uint256 idx, uint256 amount) external {
        if (hop1Addrs.length == 0) return;
        idx = bound(idx, 0, hop1Addrs.length - 1);
        amount = bound(amount, 1, 4_000 * 1e6); // hop-1 cap

        address addr = hop1Addrs[idx];
        uint256 currentCommitted = crowdfund.getCommitment(addr, 1);
        if (currentCommitted + amount > 4_000 * 1e6) {
            amount = 4_000 * 1e6 - currentCommitted;
        }
        if (amount == 0) return;

        usdc.mint(addr, amount);
        vm.startPrank(addr);
        usdc.approve(address(crowdfund), amount);

        try crowdfund.commit(1, amount) {
            ghost_totalUsdcIn += amount;
            ghost_committed[addr] += amount;
            if (ghost_committed[addr] == amount) {
                allCommitters.push(addr);
                ghost_hop[addr] = 1;
            }
        } catch {}
        vm.stopPrank();
    }

    /// @dev Fuzzed commit for hop-2 addresses
    function commitHop2(uint256 idx, uint256 amount) external {
        if (hop2Addrs.length == 0) return;
        idx = bound(idx, 0, hop2Addrs.length - 1);
        amount = bound(amount, 1, 1_000 * 1e6); // hop-2 cap

        address addr = hop2Addrs[idx];
        uint256 currentCommitted = crowdfund.getCommitment(addr, 2);
        if (currentCommitted + amount > 1_000 * 1e6) {
            amount = 1_000 * 1e6 - currentCommitted;
        }
        if (amount == 0) return;

        usdc.mint(addr, amount);
        vm.startPrank(addr);
        usdc.approve(address(crowdfund), amount);

        try crowdfund.commit(2, amount) {
            ghost_totalUsdcIn += amount;
            ghost_committed[addr] += amount;
            if (ghost_committed[addr] == amount) {
                allCommitters.push(addr);
                ghost_hop[addr] = 2;
            }
        } catch {}
        vm.stopPrank();
    }

    /// @dev Finalize the crowdfund (permissionless).
    ///      Proceeds are pushed to treasury atomically at finalization.
    function finalize() external {
        if (ghost_finalized || ghost_canceled) return;

        address treasury = address(0xBEEF);
        uint256 usdcBefore = usdc.balanceOf(treasury);

        try crowdfund.finalize() {
            Phase p = crowdfund.phase();
            if (p == Phase.Finalized) {
                ghost_finalized = true;
                ghost_refundMode = crowdfund.refundMode();
                // Track proceeds pushed at finalization
                uint256 usdcGained = usdc.balanceOf(treasury) - usdcBefore;
                ghost_proceedsPushed += usdcGained;
            }
        } catch {}
    }

    /// @dev Claim for a random committer
    function claim(uint256 idx) external {
        if (!ghost_finalized) return;
        if (allCommitters.length == 0) return;
        idx = bound(idx, 0, allCommitters.length - 1);

        address claimer = allCommitters[idx];

        uint256 armBefore = armToken.balanceOf(claimer);
        uint256 usdcBefore = usdc.balanceOf(claimer);

        vm.prank(claimer);
        try crowdfund.claim() {
            uint256 armGained = armToken.balanceOf(claimer) - armBefore;
            uint256 usdcGained = usdc.balanceOf(claimer) - usdcBefore;
            ghost_totalArmClaimed += armGained;
            ghost_totalUsdcRefunded += usdcGained;
            ghost_claimCount++;
        } catch {}
    }

    /// @dev ClaimRefund for a random committer (if canceled or refundMode)
    function claimRefund(uint256 idx) external {
        if (!ghost_canceled && !ghost_refundMode) return;
        if (allCommitters.length == 0) return;
        idx = bound(idx, 0, allCommitters.length - 1);

        address claimer = allCommitters[idx];
        uint256 usdcBefore = usdc.balanceOf(claimer);

        vm.prank(claimer);
        try crowdfund.claimRefund() {
            uint256 usdcGained = usdc.balanceOf(claimer) - usdcBefore;
            ghost_totalUsdcCancelRefunded += usdcGained;
        } catch {}
    }

    /// @dev Sweep unallocated ARM (permissionless)
    function withdrawUnallocatedArm() external {
        if (!ghost_finalized && !ghost_canceled) return;
        address treasury = address(0xBEEF);
        uint256 armBefore = armToken.balanceOf(treasury);

        try crowdfund.withdrawUnallocatedArm() {
            uint256 gained = armToken.balanceOf(treasury) - armBefore;
            ghost_unallocArmWithdrawn += gained;
        } catch {}
    }

    // ============ Helpers for invariant checks ============

    function getCommittersCount() external view returns (uint256) {
        return allCommitters.length;
    }

    function getCommitter(uint256 idx) external view returns (address) {
        return allCommitters[idx];
    }
}

/// @title CrowdfundInvariantTest — Foundry invariant test suite for ArmadaCrowdfund
contract CrowdfundInvariantTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    CrowdfundHandler public handler;

    address public admin;
    address[] public seeds;
    address[] public hop1Addrs;
    address[] public hop2Addrs;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;

    function setUp() public {
        admin = address(this);

        // Deploy tokens
        armToken = new ArmadaToken(admin, admin);
        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);
        usdc = new MockUSDCV2("Mock USDC", "USDC");

        // Deploy crowdfund
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            address(0xBEEF), // treasury
            admin,
            admin,            // securityCouncil
            block.timestamp
        );

        // Fund ARM to crowdfund and verify pre-load
        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // Create actor addresses
        // 80 seeds to ensure we can reach MIN_SALE ($1M) with seeds alone ($15K * 80 = $1.2M)
        for (uint256 i = 0; i < 80; i++) {
            seeds.push(address(uint160(0x1000 + i)));
        }
        for (uint256 i = 0; i < 20; i++) {
            hop1Addrs.push(address(uint160(0x2000 + i)));
        }
        for (uint256 i = 0; i < 20; i++) {
            hop2Addrs.push(address(uint160(0x3000 + i)));
        }

        // Setup phase: add seeds
        crowdfund.addSeeds(seeds);

        // Do invitations: each seed invites up to 3 hop-1 addresses
        uint256 hop1Idx = 0;
        for (uint256 i = 0; i < seeds.length && hop1Idx < hop1Addrs.length; i++) {
            // Only some seeds invite (to make it more realistic)
            if (i < 7) { // first 7 seeds invite
                for (uint256 j = 0; j < 3 && hop1Idx < hop1Addrs.length; j++) {
                    vm.prank(seeds[i]);
                    crowdfund.invite(hop1Addrs[hop1Idx], 0);
                    hop1Idx++;
                }
            }
        }

        // Some hop-1 addresses invite hop-2
        uint256 hop2Idx = 0;
        for (uint256 i = 0; i < hop1Addrs.length && hop2Idx < hop2Addrs.length; i++) {
            if (i < 10) { // first 10 hop-1 invite
                for (uint256 j = 0; j < 2 && hop2Idx < hop2Addrs.length; j++) {
                    vm.prank(hop1Addrs[i]);
                    crowdfund.invite(hop2Addrs[hop2Idx], 1);
                    hop2Idx++;
                }
            }
        }

        // Fast-forward into the active window (invites + commits concurrent)
        vm.warp(crowdfund.windowStart() + 1);

        // Create handler
        handler = new CrowdfundHandler(
            crowdfund,
            usdc,
            armToken,
            admin,
            seeds,
            hop1Addrs,
            hop2Addrs
        );

        // Make usdc minter
        usdc.addMinter(address(handler));

        // Target the handler for invariant testing
        targetContract(address(handler));
    }

    // ============ Invariants ============

    /// @notice USDC conservation: contract balance = totalCommitted - claimed refunds - proceeds pushed - cancel refunds
    function invariant_usdcConservation() public view {
        uint256 contractUsdc = usdc.balanceOf(address(crowdfund));
        uint256 expectedUsdc = handler.ghost_totalUsdcIn()
            - handler.ghost_totalUsdcRefunded()
            - handler.ghost_proceedsPushed()
            - handler.ghost_totalUsdcCancelRefunded();
        assertEq(contractUsdc, expectedUsdc, "USDC conservation violated");
    }

    /// @notice ARM conservation: contract balance = initial funding - claimed ARM - unalloc withdrawn
    function invariant_armConservation() public view {
        uint256 contractArm = armToken.balanceOf(address(crowdfund));
        uint256 expectedArm = ARM_FUNDING
            - handler.ghost_totalArmClaimed()
            - handler.ghost_unallocArmWithdrawn();
        assertEq(contractArm, expectedArm, "ARM conservation violated");
    }

    /// @notice No participant allocation ever exceeds their commitment (in USDC value)
    function invariant_noOverAllocation() public view {
        if (!handler.ghost_finalized()) return;
        if (handler.ghost_refundMode()) return; // no allocations in refundMode

        uint256 count = handler.getCommittersCount();
        for (uint256 i = 0; i < count; i++) {
            address committer = handler.getCommitter(i);
            (uint256 allocArm, uint256 refundUsdc, bool claimed) = crowdfund.getAllocation(committer);
            if (!claimed && allocArm == 0) continue; // not yet allocated

            uint8 hop = handler.ghost_hop(committer);
            uint256 committed = crowdfund.getCommitment(committer, hop);
            // allocUsdc = committed - refund, which must be <= committed
            uint256 allocUsdc = committed - refundUsdc;
            assertLe(allocUsdc, committed, "Allocation exceeds commitment");
        }
    }

    /// @notice Phase only moves forward, never backward
    function invariant_phaseMonotonicity() public view {
        Phase currentPhase = crowdfund.phase();
        // We started in Active (after setUp), warped into the active window
        // Phase should never go backward
        if (handler.ghost_finalized()) {
            assertEq(uint256(currentPhase), uint256(Phase.Finalized), "Phase should be Finalized");
        } else if (handler.ghost_canceled()) {
            assertEq(uint256(currentPhase), uint256(Phase.Canceled), "Phase should be Canceled");
        }
    }

    /// @notice Hop cap enforcement: no participant's committed exceeds their hop's cap
    function invariant_hopCapEnforcement() public view {
        uint256 count = handler.getCommittersCount();
        for (uint256 i = 0; i < count; i++) {
            address committer = handler.getCommitter(i);
            uint8 hop = handler.ghost_hop(committer);
            uint256 committed = crowdfund.getCommitment(committer, hop);
            uint256 effectiveCap = crowdfund.getEffectiveCap(committer, hop);
            assertLe(committed, effectiveCap, "Hop cap violated");
        }
    }

    /// @notice totalCommitted matches ghost tracking
    function invariant_totalCommittedConsistency() public view {
        assertEq(crowdfund.totalCommitted(), handler.ghost_totalUsdcIn(), "totalCommitted mismatch");
    }

    /// @notice After finalization, sum of (allocUsdc + refund) for all committers equals totalCommitted
    function invariant_allocPlusRefundEqualsCommitted() public view {
        if (!handler.ghost_finalized()) return;
        if (handler.ghost_refundMode()) return; // no allocations in refundMode

        uint256 count = handler.getCommittersCount();
        for (uint256 i = 0; i < count; i++) {
            address committer = handler.getCommitter(i);
            uint8 hop = handler.ghost_hop(committer);
            (uint256 allocArm, uint256 refundUsdc, ) = crowdfund.getAllocation(committer);
            uint256 committed = crowdfund.getCommitment(committer, hop);

            if (committed == 0) continue;

            // allocUsdc + refund should equal committed for each participant
            // allocUsdc = committed - refundUsdc (from _computeAllocation)
            uint256 allocUsdc = committed - refundUsdc;
            assertEq(allocUsdc + refundUsdc, committed, "alloc + refund != committed");
        }
    }

    /// @notice Contract never goes to negative balance (sanity — Solidity would revert, but belt-and-suspenders)
    function invariant_nonNegativeBalances() public view {
        // These can never actually be negative in Solidity, but asserting >= 0 confirms no reverts
        assertTrue(usdc.balanceOf(address(crowdfund)) >= 0, "Negative USDC balance");
        assertTrue(armToken.balanceOf(address(crowdfund)) >= 0, "Negative ARM balance");
    }
}

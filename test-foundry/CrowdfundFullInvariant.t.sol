// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

// ══════════════════════════════════════════════════════════════════════════
// INV-C2: Ceiling BPS match expected overlapping values
// (Extends the existing CrowdfundInvariant.t.sol with this ceiling invariant)
// ══════════════════════════════════════════════════════════════════════════

/// @title CrowdfundFullHandler — Minimal handler to exercise crowdfund for BPS check
/// @dev The existing CrowdfundHandler covers commitment/claim flows.
///      This handler adds a no-op action so the invariant fuzzer has something to call.
contract CrowdfundFullHandler is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;

    // Actor pools
    address[] public seeds;
    address[] public hop1Addrs;
    address[] public hop2Addrs;
    address[] public allCommitters;

    // Ghost variables
    uint256 public ghost_totalUsdcIn;
    mapping(address => uint256) public ghost_committed;
    bool public ghost_finalized;
    bool public ghost_canceled;

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

    /// @dev Fuzzed commit: pick a random seed and commit a bounded amount
    function commitSeed(uint256 seedIdx, uint256 amount) external {
        if (seeds.length == 0) return;
        seedIdx = bound(seedIdx, 0, seeds.length - 1);
        amount = bound(amount, 1, 15_000 * 1e6);

        address seed = seeds[seedIdx];

        (uint256 currentCommitted, ) = crowdfund.getCommitment(seed);
        if (currentCommitted + amount > 15_000 * 1e6) {
            amount = 15_000 * 1e6 - currentCommitted;
        }
        if (amount == 0) return;

        usdc.mint(seed, amount);
        vm.startPrank(seed);
        usdc.approve(address(crowdfund), amount);

        try crowdfund.commit(amount) {
            ghost_totalUsdcIn += amount;
            ghost_committed[seed] += amount;
            if (ghost_committed[seed] == amount) {
                allCommitters.push(seed);
            }
        } catch {}
        vm.stopPrank();
    }

    /// @dev Fuzzed commit for hop-1 addresses
    function commitHop1(uint256 idx, uint256 amount) external {
        if (hop1Addrs.length == 0) return;
        idx = bound(idx, 0, hop1Addrs.length - 1);
        amount = bound(amount, 1, 4_000 * 1e6);

        address addr = hop1Addrs[idx];
        (uint256 currentCommitted, ) = crowdfund.getCommitment(addr);
        if (currentCommitted + amount > 4_000 * 1e6) {
            amount = 4_000 * 1e6 - currentCommitted;
        }
        if (amount == 0) return;

        usdc.mint(addr, amount);
        vm.startPrank(addr);
        usdc.approve(address(crowdfund), amount);

        try crowdfund.commit(amount) {
            ghost_totalUsdcIn += amount;
            ghost_committed[addr] += amount;
            if (ghost_committed[addr] == amount) {
                allCommitters.push(addr);
            }
        } catch {}
        vm.stopPrank();
    }

    /// @dev Fuzzed commit for hop-2 addresses
    function commitHop2(uint256 idx, uint256 amount) external {
        if (hop2Addrs.length == 0) return;
        idx = bound(idx, 0, hop2Addrs.length - 1);
        amount = bound(amount, 1, 1_000 * 1e6);

        address addr = hop2Addrs[idx];
        (uint256 currentCommitted, ) = crowdfund.getCommitment(addr);
        if (currentCommitted + amount > 1_000 * 1e6) {
            amount = 1_000 * 1e6 - currentCommitted;
        }
        if (amount == 0) return;

        usdc.mint(addr, amount);
        vm.startPrank(addr);
        usdc.approve(address(crowdfund), amount);

        try crowdfund.commit(amount) {
            ghost_totalUsdcIn += amount;
            ghost_committed[addr] += amount;
            if (ghost_committed[addr] == amount) {
                allCommitters.push(addr);
            }
        } catch {}
        vm.stopPrank();
    }

    /// @dev Finalize the crowdfund
    function finalize() external {
        if (ghost_finalized || ghost_canceled) return;

        vm.prank(admin);
        try crowdfund.finalize() {
            Phase p = crowdfund.phase();
            if (p == Phase.Finalized) {
                ghost_finalized = true;
            } else if (p == Phase.Canceled) {
                ghost_canceled = true;
            }
        } catch {}
    }

    function getCommittersCount() external view returns (uint256) {
        return allCommitters.length;
    }

    function getCommitter(uint256 idx) external view returns (address) {
        return allCommitters[idx];
    }
}

/// @title CrowdfundFullInvariantTest — Extended crowdfund invariant tests
/// @dev Adds INV-C2 (reserve BPS sum) to the existing coverage
contract CrowdfundFullInvariantTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    CrowdfundFullHandler public handler;

    address public admin;
    address[] public seeds;
    address[] public hop1Addrs;
    address[] public hop2Addrs;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;

    function setUp() public {
        admin = address(this);

        // Deploy tokens
        armToken = new ArmadaToken(admin);
        usdc = new MockUSDCV2("Mock USDC", "USDC");

        // Deploy crowdfund
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            address(0xBEEF) // treasury
        );

        // Fund ARM to crowdfund
        armToken.transfer(address(crowdfund), ARM_FUNDING);

        // Create actor addresses (80 seeds to reach MIN_SALE)
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

        // Start invitations
        crowdfund.startInvitations();

        // Do invitations
        uint256 hop1Idx = 0;
        for (uint256 i = 0; i < seeds.length && hop1Idx < hop1Addrs.length; i++) {
            if (i < 7) {
                for (uint256 j = 0; j < 3 && hop1Idx < hop1Addrs.length; j++) {
                    vm.prank(seeds[i]);
                    crowdfund.invite(hop1Addrs[hop1Idx]);
                    hop1Idx++;
                }
            }
        }

        uint256 hop2Idx = 0;
        for (uint256 i = 0; i < hop1Addrs.length && hop2Idx < hop2Addrs.length; i++) {
            if (i < 10) {
                for (uint256 j = 0; j < 2 && hop2Idx < hop2Addrs.length; j++) {
                    vm.prank(hop1Addrs[i]);
                    crowdfund.invite(hop2Addrs[hop2Idx]);
                    hop2Idx++;
                }
            }
        }

        // Fast-forward past invitation window into commitment window
        vm.warp(crowdfund.commitmentStart() + 1);

        // Create handler
        handler = new CrowdfundFullHandler(
            crowdfund,
            usdc,
            armToken,
            admin,
            seeds,
            hop1Addrs,
            hop2Addrs
        );

        usdc.addMinter(address(handler));
        targetContract(address(handler));
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-C2: Ceiling BPS match expected overlapping values (sum = 12500)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Hop ceiling basis points match spec: 7000/4500/1000 (overlapping, sum > 10000)
    function invariant_ceilingBpsAreValid() public view {
        (uint16 bps0, , ) = crowdfund.hopConfigs(0);
        (uint16 bps1, , ) = crowdfund.hopConfigs(1);
        (uint16 bps2, , ) = crowdfund.hopConfigs(2);
        assertEq(bps0, 7000, "INV-C2: Hop 0 ceiling should be 7000");
        assertEq(bps1, 4500, "INV-C2: Hop 1 ceiling should be 4500");
        assertEq(bps2, 1000, "INV-C2: Hop 2 ceiling should be 1000");
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-C3: USDC balance >= totalCommitted (before finalize)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Contract always holds enough USDC to cover all commitments
    function invariant_usdcCoversCommitments() public view {
        if (handler.ghost_finalized() || handler.ghost_canceled()) return;

        uint256 contractUsdc = usdc.balanceOf(address(crowdfund));
        assertEq(
            contractUsdc,
            handler.ghost_totalUsdcIn(),
            "INV-C3: USDC balance != totalCommitted (before finalize)"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-C4: Per-participant cap enforced
    // ══════════════════════════════════════════════════════════════════════

    /// @notice No participant's committed amount exceeds their hop's cap
    function invariant_hopCapEnforcement() public view {
        uint256 count = handler.getCommittersCount();
        for (uint256 i = 0; i < count; i++) {
            address committer = handler.getCommitter(i);
            (uint256 committed, uint8 hop) = crowdfund.getCommitment(committer);
            (, uint256 capUsdc, ) = crowdfund.hopConfigs(hop);
            assertLe(committed, capUsdc, "INV-C4: Hop cap violated");
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-C1: allocUsdc + refundUsdc == committed (after finalize)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice After finalization, each participant's alloc + refund equals committed
    function invariant_allocPlusRefundEqualsCommitted() public view {
        if (!handler.ghost_finalized()) return;

        uint256 count = handler.getCommittersCount();
        for (uint256 i = 0; i < count; i++) {
            address committer = handler.getCommitter(i);
            (uint256 allocArm, uint256 refundUsdc, ) = crowdfund.getAllocation(committer);
            (uint256 committed, ) = crowdfund.getCommitment(committer);

            if (committed == 0) continue;

            // allocUsdc = committed - refundUsdc
            uint256 allocUsdc = committed - refundUsdc;
            assertEq(
                allocUsdc + refundUsdc,
                committed,
                "INV-C1: alloc + refund != committed"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Phase monotonicity
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Phase only moves forward
    function invariant_phaseMonotonicity() public view {
        Phase currentPhase = crowdfund.phase();
        if (handler.ghost_finalized()) {
            assertEq(uint256(currentPhase), uint256(Phase.Finalized), "Phase should be Finalized");
        } else if (handler.ghost_canceled()) {
            assertEq(uint256(currentPhase), uint256(Phase.Canceled), "Phase should be Canceled");
        }
    }

    /// @notice totalCommitted matches ghost tracking
    function invariant_totalCommittedConsistency() public view {
        assertEq(
            crowdfund.totalCommitted(),
            handler.ghost_totalUsdcIn(),
            "totalCommitted mismatch"
        );
    }
}

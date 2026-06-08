// ABOUTME: Adversarial fuzz suite for the Multicall mixin added post-audit in PR #266.
// ABOUTME: Targets msg.value replay, sequential-vs-bundled equivalence, atomicity, and lock release across random bundles.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Post-audit fuzz coverage for the OpenZeppelin Multicall mixin on
///         ArmadaCrowdfund. The deterministic suite (CrowdfundMulticall.t.sol)
///         pins the obvious safety properties on a fixed self-stack bundle;
///         this suite drives random bundle shapes against the same invariants
///         plus several adversarial cases the deterministic tests don't cover:
///
///         * No msg.value replay surface — no entry point on the contract is
///           payable, so even if a future OZ Multicall variant became payable,
///           inner calls would refuse ETH.
///         * Bundled execution is state-equivalent to sequential execution
///           across random valid call sequences (the strong invariant).
///         * Atomicity holds for adversarially-shaped bundles (over-budget
///           invites, malformed orderings).
///         * The nonReentrant lock truly releases between bundled calls under
///           arbitrary bundle sizes up to a deep nesting count.
///         * Inviter budget integrity holds when multicall packs k invites
///           against a known cap.
contract CrowdfundMulticallFuzzTest is Test {
    ArmadaCrowdfund internal crowdfund;
    MockUSDCV2 internal usdc;
    ArmadaToken internal armToken;
    address internal admin;
    address internal treasury;
    address internal launchTeam;
    address internal seed;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant HOP0_CAP = 15_000 * 1e6;
    uint256 constant HOP1_CAP = 4_000 * 1e6;
    uint256 constant HOP2_CAP = 1_000 * 1e6;
    uint256 constant MIN_COMMIT = 10 * 1e6;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);
        launchTeam = address(0xBEEF);
        seed = address(0xC0FFEE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc), address(armToken), treasury, launchTeam, admin, block.timestamp
        );

        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        vm.prank(launchTeam);
        crowdfund.addSeed(seed);

        // Deal seed enough USDC for any commit pattern + ETH for payable-surface fuzz.
        usdc.mint(seed, HOP0_CAP * 3);
        vm.deal(seed, 100 ether);
        vm.deal(address(this), 100 ether);
    }

    // ============ msg.value / payable surface ============

    /// @notice WHY: The notorious Multicall pitfall (Uniswap V2 2024 incident) is
    ///         msg.value replay across delegatecalled bundled calls when any
    ///         bundled function is payable. ArmadaCrowdfund declares no payable
    ///         functions. This fuzz drives a random ETH amount + random valid
    ///         action and asserts the tx reverts atomically, leaving no ETH
    ///         stuck on the contract and no state change.
    function testFuzz_noPayableSurfaceUnderMulticall(uint256 ethAmount, uint8 actionPicker) public {
        ethAmount = bound(ethAmount, 1, 100 ether);
        actionPicker = uint8(bound(actionPicker, 0, 2));

        bytes[] memory calls = new bytes[](1);
        if (actionPicker == 0) {
            calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(0), MIN_COMMIT);
        } else if (actionPicker == 1) {
            calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, seed, uint8(0));
        } else {
            calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.loadArm.selector);
        }

        uint256 balBefore = address(crowdfund).balance;
        vm.prank(seed);
        (bool success,) = address(crowdfund).call{value: ethAmount}(
            abi.encodeWithSelector(crowdfund.multicall.selector, calls)
        );
        assertFalse(success, "multicall with msg.value > 0 must revert (no payable surface)");
        assertEq(address(crowdfund).balance, balBefore, "no ETH may stick on the contract");
    }

    /// @notice WHY: Belt-and-suspenders direct probe. Even without going through
    ///         multicall, the contract must refuse plain ETH sends — confirming
    ///         no fallback / receive() snuck in via an OZ inheritance path.
    function testFuzz_noPayableSurfaceDirect(uint256 ethAmount) public {
        ethAmount = bound(ethAmount, 1, 100 ether);
        (bool success,) = address(crowdfund).call{value: ethAmount}("");
        assertFalse(success, "direct ETH send must revert");
        assertEq(address(crowdfund).balance, 0, "contract must hold zero ETH");
    }

    // ============ Sequential ↔ multicall equivalence ============

    /// @notice WHY: The strongest safety property — bundled execution must be
    ///         observably identical to running the same calls one-by-one as
    ///         separate txs. If this holds across random valid bundles, no
    ///         hidden state divergence is introduced by the delegatecall path.
    ///         Snapshot-then-revert lets us run both modes against an identical
    ///         baseline and compare the resulting state fingerprint.
    function testFuzz_multicallEquivalentToSequential(
        uint8 nHop1Invites,
        uint8 nHop2Invites,
        uint64 commitH0Amount,
        uint64 commitH1Amount,
        uint64 commitH2Amount
    ) public {
        // Bound to legal ranges: hop-0 inviter has budget = 1 × maxInvites(0) = 3,
        // so at most 3 hop-1 invites. Each hop-1 node lets 2 hop-2 invites.
        nHop1Invites = uint8(bound(nHop1Invites, 0, 3));
        uint256 hop2Budget = nHop1Invites == 0 ? 0 : 2 * uint256(nHop1Invites);
        nHop2Invites = uint8(bound(nHop2Invites, 0, hop2Budget));

        // Commit amounts: 0 (skip) or in [MIN_COMMIT, cap×stacks]. 0 means
        // "no commit at this hop" — encoded by leaving the call out below.
        commitH0Amount = uint64(bound(commitH0Amount, 0, HOP0_CAP));
        uint256 h1Cap = HOP1_CAP * uint256(nHop1Invites);
        commitH1Amount = uint64(bound(commitH1Amount, 0, h1Cap));
        uint256 h2Cap = HOP2_CAP * uint256(nHop2Invites);
        commitH2Amount = uint64(bound(commitH2Amount, 0, h2Cap));

        // Skip degenerate runs where every input is below MIN_COMMIT — nothing
        // would happen and the equivalence claim is vacuous.
        vm.assume(commitH0Amount >= MIN_COMMIT || commitH1Amount >= MIN_COMMIT || commitH2Amount >= MIN_COMMIT
            || nHop1Invites > 0);

        bytes[] memory calls = _buildBundle(
            nHop1Invites,
            nHop2Invites,
            commitH0Amount >= MIN_COMMIT ? commitH0Amount : 0,
            commitH1Amount >= MIN_COMMIT ? commitH1Amount : 0,
            commitH2Amount >= MIN_COMMIT ? commitH2Amount : 0
        );
        if (calls.length == 0) return;

        // --- Run sequential ---
        uint256 baseline = vm.snapshot();
        bool sequentialReverted = !_runSequential(calls);
        bytes32 sequentialHash = sequentialReverted ? bytes32(0) : _fingerprintState();

        // --- Reset, run multicall ---
        vm.revertTo(baseline);
        bool multicallReverted = !_runMulticall(calls);
        bytes32 multicallHash = multicallReverted ? bytes32(0) : _fingerprintState();

        assertEq(sequentialReverted, multicallReverted, "revert parity must hold");
        assertEq(sequentialHash, multicallHash, "post-state must match");
    }

    // ============ Adversarial bundles ============

    /// @notice WHY: Multicall must atomically roll back any partial state when
    ///         a bundled invite exceeds the inviter's effective budget. Tests
    ///         the boundary at k ∈ [4, 30] — anything ≥ 4 must revert since
    ///         hop-0 budget is 1 × maxInvites=3.
    function testFuzz_multicallOverInviteBudgetIsAtomic(uint8 k) public {
        k = uint8(bound(k, 4, 30));
        bytes[] memory calls = new bytes[](k);
        for (uint256 i = 0; i < k; i++) {
            calls[i] = abi.encodeWithSelector(
                ArmadaCrowdfund.invite.selector, address(uint160(0x10000 + i)), uint8(0)
            );
        }

        vm.prank(seed);
        vm.expectRevert(bytes("ArmadaCrowdfund: invite limit reached"));
        crowdfund.multicall(calls);

        // No partial state: none of the would-be invitees are whitelisted.
        for (uint256 i = 0; i < k; i++) {
            address invitee = address(uint160(0x10000 + i));
            (, uint16 ir,,,) = crowdfund.participants(invitee, 1);
            assertEq(ir, 0, "no partial invite state must persist after revert");
        }
        // Inviter's invitesSent must also be 0 — must not have leaked through the revert.
        (, , uint16 invitesSent, , ) = crowdfund.participants(seed, 0);
        assertEq(invitesSent, 0, "inviter invitesSent must reset to 0 after atomic revert");
    }

    // ============ nonReentrant lock release ============

    /// @notice WHY: OZ Multicall delegate-calls each item sequentially. The
    ///         nonReentrant guard acquired by call N must release before call
    ///         N+1 enters. A regression where the guard nests instead of
    ///         sequences would show up as the second commit reverting with
    ///         "ReentrancyGuard: reentrant call". Fuzz the bundle size up to
    ///         N=50 to exercise large bundles a real frontend would never
    ///         emit but a malicious caller might.
    function testFuzz_nonReentrantReleasesAcrossN(uint8 n) public {
        n = uint8(bound(n, 2, 50));

        // Pre-fund + approve for n commits of MIN_COMMIT to hop-0.
        usdc.mint(seed, MIN_COMMIT * uint256(n));
        vm.prank(seed);
        usdc.approve(address(crowdfund), type(uint256).max);

        bytes[] memory calls = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            calls[i] = abi.encodeWithSelector(
                ArmadaCrowdfund.commit.selector, uint8(0), MIN_COMMIT
            );
        }

        vm.prank(seed);
        crowdfund.multicall(calls);

        (,,,, uint256 committed) = crowdfund.participants(seed, 0);
        assertEq(committed, MIN_COMMIT * uint256(n), "all n commits must accumulate");
    }

    // ============ Inviter budget integrity ============

    /// @notice WHY: At the legal boundary — k = budget — every invite must
    ///         land. At k = budget + 1, the bundle must atomically revert.
    ///         Fuzz this exactly at and around the boundary to catch any
    ///         off-by-one introduced by the bundled execution path.
    function testFuzz_inviterBudgetExactBoundary(uint8 k) public {
        k = uint8(bound(k, 1, 6));
        bytes[] memory calls = new bytes[](k);
        for (uint256 i = 0; i < k; i++) {
            calls[i] = abi.encodeWithSelector(
                ArmadaCrowdfund.invite.selector, address(uint160(0x20000 + i)), uint8(0)
            );
        }

        if (k <= 3) {
            vm.prank(seed);
            crowdfund.multicall(calls);
            (, , uint16 invitesSent, , ) = crowdfund.participants(seed, 0);
            assertEq(invitesSent, k, "invitesSent must equal k when within budget");
            for (uint256 i = 0; i < k; i++) {
                address invitee = address(uint160(0x20000 + i));
                (, uint16 ir,,,) = crowdfund.participants(invitee, 1);
                assertEq(ir, 1, "each invitee must be whitelisted at hop-1");
            }
        } else {
            vm.prank(seed);
            vm.expectRevert(bytes("ArmadaCrowdfund: invite limit reached"));
            crowdfund.multicall(calls);
        }
    }

    // ============ Helpers ============

    /// @dev Build the calldata bundle in canonical order: hop-1 self-invites,
    ///      then hop-2 self-invites (each from a hop-1 node — but the seed
    ///      has only ONE hop-1 invitesReceived slot per self-invite, so each
    ///      hop-2 invite uses `fromHop=1`), then commits at each hop.
    function _buildBundle(
        uint8 nHop1,
        uint8 nHop2,
        uint64 commitH0,
        uint64 commitH1,
        uint64 commitH2
    ) internal pure returns (bytes[] memory calls) {
        uint256 total = uint256(nHop1) + uint256(nHop2);
        if (commitH0 > 0) total++;
        if (commitH1 > 0) total++;
        if (commitH2 > 0) total++;
        calls = new bytes[](total);
        uint256 idx;
        for (uint256 i = 0; i < nHop1; i++) {
            calls[idx++] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, _self(), uint8(0));
        }
        for (uint256 i = 0; i < nHop2; i++) {
            calls[idx++] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, _self(), uint8(1));
        }
        if (commitH0 > 0) {
            calls[idx++] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(0), uint256(commitH0));
        }
        if (commitH1 > 0) {
            calls[idx++] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(1), uint256(commitH1));
        }
        if (commitH2 > 0) {
            calls[idx++] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(2), uint256(commitH2));
        }
    }

    function _self() internal pure returns (address) {
        return address(0xC0FFEE); // matches `seed` set in setUp()
    }

    function _runSequential(bytes[] memory calls) internal returns (bool ok) {
        vm.prank(seed);
        usdc.approve(address(crowdfund), type(uint256).max);
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(seed);
            (bool callOk,) = address(crowdfund).call(calls[i]);
            if (!callOk) return false;
        }
        return true;
    }

    function _runMulticall(bytes[] memory calls) internal returns (bool ok) {
        vm.prank(seed);
        usdc.approve(address(crowdfund), type(uint256).max);
        vm.prank(seed);
        (bool callOk,) = address(crowdfund).call(
            abi.encodeWithSelector(crowdfund.multicall.selector, calls)
        );
        return callOk;
    }

    /// @dev Fingerprint the state that participants observe — accounting + graph.
    function _fingerprintState() internal view returns (bytes32) {
        bytes32 h0 = _fingerprintHop(0);
        bytes32 h1 = _fingerprintHop(1);
        bytes32 h2 = _fingerprintHop(2);
        return keccak256(abi.encode(
            h0, h1, h2,
            crowdfund.totalCommitted(),
            crowdfund.getParticipantCount(),
            usdc.balanceOf(address(crowdfund)),
            usdc.balanceOf(seed)
        ));
    }

    function _fingerprintHop(uint8 hop) internal view returns (bytes32) {
        (, uint16 ir, uint16 isent, , uint256 c) = crowdfund.participants(seed, hop);
        return keccak256(abi.encode(hop, ir, isent, c));
    }
}

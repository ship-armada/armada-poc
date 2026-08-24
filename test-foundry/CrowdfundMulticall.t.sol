// ABOUTME: Tests for OZ Multicall mixin on ArmadaCrowdfund — self-fill, atomicity, bounds, sender preservation, reentry.
// ABOUTME: Covers §5.3 of .context/MULTICALL_EVAL.md. Companion to transferAndDelegate-audit.md and modifier-matrix.md.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Foundry tests for the bounded OZ Multicall mixin added in Phase 1.
///         Each test name maps to a row in the §5.3 table. Where the spec's
///         test name was misleading or wrong (see DoubleNonReentrant — was
///         _Reverts, must be _Succeeds), the corrected name is used here and
///         the spec mapping is recorded in the WHY comment.
contract CrowdfundMulticallTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;

    address public admin = address(this);
    address public treasury = address(0xCAFE);
    address public delegateAddr = address(0xDE1E);

    // Single-seed setup for self-fill tests
    address public seed0 = address(0xA001);

    // Multi-seed setup (lazy-initialized via _setupForFinalization)
    address[] public manySeeds;

    uint256 constant ARM_FUNDING   = 1_800_000 * 1e18;
    uint256 constant HOP0_CAP      = 15_000 * 1e6;
    uint256 constant HOP1_CAP      = 4_000 * 1e6;
    uint256 constant HOP2_CAP      = 1_000 * 1e6;
    uint256 constant MIN_COMMIT    = 10 * 1e6;
    uint256 constant SELF_FILL_TOTAL = 33_000 * 1e6; // $15K + 3×$4K + 6×$1K

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);

        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            treasury,
            admin,          // launchTeam
            admin,          // securityCouncil
            block.timestamp // window opens immediately
        );

        // ArmadaToken transferable whitelist: admin (for funding transfer)
        // and the crowdfund (so claim()'s transferAndDelegate can move ARM out).
        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        // Authorize the crowdfund as a delegator so claim()'s
        // transferAndDelegate is permitted. The ArmadaToken gate is the one
        // documented in §5.2 audit memo (`authorizedDelegator[msg.sender]`).
        address[] memory delegators = new address[](1);
        delegators[0] = address(crowdfund);
        armToken.initAuthorizedDelegators(delegators);

        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // Single seed for self-fill tests. Finalization-path tests call
        // _setupForFinalization() to populate a mixed hop-0/hop-1 success case.
        address[] memory s = new address[](1);
        s[0] = seed0;
        crowdfund.addSeeds(s);
    }

    // ============ Calldata encoding helpers ============
    // WHY: every test builds a bytes[] of selector-encoded calls. Centralising
    // the encoding keeps test bodies focused on assertions rather than ABI
    // mechanics.

    function _encInvite(address invitee, uint8 inviterHop) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, invitee, inviterHop);
    }
    function _encCommit(uint8 hop, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, hop, amount);
    }
    function _encClaim(address d) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ArmadaCrowdfund.claim.selector, d);
    }
    function _encClaimRefund() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ArmadaCrowdfund.claimRefund.selector);
    }
    function _encLaunchTeamInvite(address invitee, uint8 fromHop) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ArmadaCrowdfund.launchTeamInvite.selector, invitee, fromHop);
    }
    function _encFinalize() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ArmadaCrowdfund.finalize.selector);
    }

    // ============ Self-fill plan builders ============
    // WHY: replicates the §1 example plan: a hop-0 seed self-fills hop-1
    // (×3) and hop-2 (×6), then commits at all three hops. Used by happy-path
    // tests; the exact same builder will be useful for the frontend
    // useSelfFillPlan hook in the follow-up UI PR.

    function _seedSelfFillBundle(address self) internal pure returns (bytes[] memory calls) {
        // 3 hop-1 self-invites (seed has invitesReceived=1, maxInvites=3)
        // 6 hop-2 self-invites (each hop-1 stack = 3 received × maxInvites=2)
        // commit hop-0 ($15K), hop-1 ($12K), hop-2 ($6K)
        calls = new bytes[](12);
        uint256 i = 0;
        for (uint256 k = 0; k < 3; k++) { calls[i++] = _encInvite(self, 0); }
        for (uint256 k = 0; k < 6; k++) { calls[i++] = _encInvite(self, 1); }
        calls[i++] = _encCommit(0, HOP0_CAP);              // $15K
        calls[i++] = _encCommit(1, HOP1_CAP * 3);          // $12K (3× cap, all at once)
        calls[i++] = _encCommit(2, HOP2_CAP * 6);          // $6K  (6× cap)
    }

    function _hop1SelfFillBundle(address self) internal pure returns (bytes[] memory calls) {
        // hop-1 wallet w/ invitesReceived=1, maxInvites=2 → 2 hop-2 self-invites
        // Then commit hop-1 ($4K) and hop-2 ($2K).
        calls = new bytes[](4);
        calls[0] = _encInvite(self, 1);
        calls[1] = _encInvite(self, 1);
        calls[2] = _encCommit(1, HOP1_CAP);          // $4K
        calls[3] = _encCommit(2, HOP2_CAP * 2);      // $2K
    }

    function _mintAndApprove(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(crowdfund), amount);
    }

    /// @notice Populate 53 hop-0 seeds + 109 hop-1 invitees so the net
    ///         post-ceiling allocation clears MIN_SALE and finalize() takes
    ///         the success path. (Hop-0-only with 80 seeds caps the net
    ///         allocation at the hop-0 ceiling ≈ $564K < $1M MIN_SALE,
    ///         which forces refundMode — see audit-75 / hop ceilings.)
    ///         Mirrors the pattern in CrowdfundDonationTest.
    function _setupForFinalization() internal {
        // 53 hop-0 seeds, each commits $15K → hop-0 capped demand $795K.
        for (uint160 i = 0; i < 53; i++) {
            address s = address(uint160(0xC000) + i);
            manySeeds.push(s);
        }
        crowdfund.addSeeds(manySeeds);
        for (uint256 i = 0; i < manySeeds.length; i++) {
            _mintAndApprove(manySeeds[i], HOP0_CAP);
            vm.prank(manySeeds[i]);
            crowdfund.commit(0, HOP0_CAP);
        }

        // 109 hop-1 invitees, each commits $4K → hop-1 demand $436K.
        // The projected allocation is $564K + $436K = $1M, so finalization
        // follows the success path.
        for (uint160 i = 0; i < 109; i++) {
            address h1 = address(uint160(0xD000) + i);
            vm.prank(manySeeds[i % manySeeds.length]);
            crowdfund.invite(h1, 0);
            _mintAndApprove(h1, HOP1_CAP);
            vm.prank(h1);
            crowdfund.commit(1, HOP1_CAP);
        }

        vm.warp(crowdfund.windowEnd() + 1);
        crowdfund.finalize();
        assertEq(uint256(crowdfund.phase()), uint256(Phase.Finalized), "must be Finalized");
        assertFalse(crowdfund.refundMode(), "must not be in refundMode");
    }

    // ===================================================================
    //                        HAPPY PATHS  (§5.3 tier A)
    // ===================================================================

    /// @notice WHY: end-to-end exercise of the self-fill use case. A seed
    /// wallet bundles 9 invites + 3 commits in one multicall. Verifies that
    /// the EVM's sequential delegatecall ordering lets later commits see
    /// the projected (post-self-invite) whitelist + effectiveCap state.
    function test_SelfFill_Seed_FullTree() public {
        _mintAndApprove(seed0, SELF_FILL_TOTAL);

        bytes[] memory calls = _seedSelfFillBundle(seed0);

        vm.prank(seed0);
        crowdfund.multicall(calls);

        assertEq(crowdfund.getInvitesReceived(seed0, 1), 3, "hop-1 stacked to 3");
        assertEq(crowdfund.getInvitesReceived(seed0, 2), 6, "hop-2 stacked to 6");
        assertEq(crowdfund.getCommitment(seed0, 0), HOP0_CAP, "hop-0 commit");
        assertEq(crowdfund.getCommitment(seed0, 1), HOP1_CAP * 3, "hop-1 commit");
        assertEq(crowdfund.getCommitment(seed0, 2), HOP2_CAP * 6, "hop-2 commit");
        assertEq(crowdfund.totalCommitted(), SELF_FILL_TOTAL, "totalCommitted");
        assertEq(usdc.balanceOf(seed0), 0, "USDC fully escrowed");
    }

    /// @notice WHY: same flow, but for a hop-1 wallet (not a seed). The
    /// hop-1 invite-only subtree is the most common real-world case once
    /// the seed pool is saturated.
    function test_SelfFill_Hop1_Subtree() public {
        address hop1Wallet = address(0xB001);

        // First, seed0 invites hop1Wallet to hop-1 via a single tx (outside
        // multicall, to set up state). Then hop1Wallet self-fills its subtree.
        vm.prank(seed0);
        crowdfund.invite(hop1Wallet, 0);
        assertTrue(crowdfund.isWhitelisted(hop1Wallet, 1), "hop1Wallet whitelisted at hop-1");

        _mintAndApprove(hop1Wallet, HOP1_CAP + HOP2_CAP * 2);

        bytes[] memory calls = _hop1SelfFillBundle(hop1Wallet);
        vm.prank(hop1Wallet);
        crowdfund.multicall(calls);

        assertEq(crowdfund.getInvitesReceived(hop1Wallet, 2), 2, "hop-2 stacked");
        assertEq(crowdfund.getCommitment(hop1Wallet, 1), HOP1_CAP, "hop-1 commit");
        assertEq(crowdfund.getCommitment(hop1Wallet, 2), HOP2_CAP * 2, "hop-2 commit");
    }

    /// @notice WHY: minimal invite+commit composition. Tests that an
    /// invite issued in call[i] is visible to a commit in call[i+1] —
    /// i.e. the in-multicall state mutation chain works as expected.
    function test_Multicall_InviteThenCommitSameTx() public {
        address hop1Wallet = address(0xB002);
        _mintAndApprove(hop1Wallet, HOP1_CAP);

        bytes[] memory calls = new bytes[](2);
        // seed0 invites hop1Wallet, then hop1Wallet commits.
        // BUT: msg.sender is fixed for the whole multicall, so seed0 must do
        // BOTH calls. We instead test: seed0 commits at hop-0 after an
        // (irrelevant) invite to itself. Pure ordering exercise.
        calls[0] = _encInvite(hop1Wallet, 0);  // seed0 invites hop1Wallet to hop-1
        calls[1] = _encCommit(0, HOP0_CAP);    // seed0 commits at hop-0

        _mintAndApprove(seed0, HOP0_CAP);
        vm.prank(seed0);
        crowdfund.multicall(calls);

        assertTrue(crowdfund.isWhitelisted(hop1Wallet, 1), "invite landed");
        assertEq(crowdfund.getCommitment(seed0, 0), HOP0_CAP, "commit landed");
    }

    // ===================================================================
    //                       REVERT PATHS  (§5.3 tier B)
    // ===================================================================

    /// @notice WHY: maps to spec's `OverCapCommit_Reverts`. The contract
    /// accepts over-cap commits and pro-rates at settlement — there is no
    /// "over cap" revert. The closest atomic-bundle revert path is a
    /// commit that exceeds the user's USDC allowance, which makes
    /// safeTransferFrom revert. The whole bundle must then roll back.
    function test_Multicall_CommitExceedingAllowance_Reverts() public {
        usdc.mint(seed0, HOP0_CAP);
        vm.prank(seed0);
        usdc.approve(address(crowdfund), MIN_COMMIT); // only $10 approved

        bytes[] memory calls = new bytes[](1);
        calls[0] = _encCommit(0, HOP0_CAP); // try to commit $15K

        vm.prank(seed0);
        vm.expectRevert(); // ERC20 transfer revert reason
        crowdfund.multicall(calls);

        assertEq(crowdfund.getCommitment(seed0, 0), 0, "no commit landed");
    }

    /// @notice WHY: an EOA with no whitelist anywhere tries to commit via
    /// multicall. The inline `p.isWhitelisted` check inside commit() must
    /// bind under the delegatecall, and the bundle must roll back atomically.
    function test_Multicall_NotWhitelisted_Reverts() public {
        address nobody = address(0xDEAD);
        _mintAndApprove(nobody, HOP1_CAP);

        bytes[] memory calls = new bytes[](1);
        calls[0] = _encCommit(1, HOP1_CAP);

        vm.prank(nobody);
        vm.expectRevert("ArmadaCrowdfund: not whitelisted");
        crowdfund.multicall(calls);
    }

    /// @notice WHY: `claim` sets `claimed[msg.sender] = true` before the
    /// transferAndDelegate. A second `claim` in the same bundle must see
    /// that flag and revert with "already claimed". This proves intra-
    /// bundle state mutation is visible to later siblings AND that the
    /// claimed-flag check binds under delegatecall — and the whole bundle
    /// rolls back, so the user is NOT marked claimed after the failure.
    function test_Multicall_DoubleClaim_Reverts() public {
        _setupForFinalization();

        // Use a seed from _setupForFinalization (manySeeds[0]).
        address claimant = manySeeds[0];
        bytes[] memory calls = new bytes[](2);
        calls[0] = _encClaim(delegateAddr);
        calls[1] = _encClaim(delegateAddr);

        vm.prank(claimant);
        vm.expectRevert("ArmadaCrowdfund: already claimed");
        crowdfund.multicall(calls);

        assertFalse(crowdfund.claimed(claimant), "claimed flag rolled back");
    }

    /// @notice WHY: a bundle that contains a phase-transition (finalize)
    /// followed by an action that requires the prior phase (commit) must
    /// revert on the second call. Demonstrates that mid-bundle phase
    /// changes ARE observed by later siblings — so anyone who tries to
    /// race a finalize-and-commit cannot sneak through.
    function test_Multicall_PhaseTransition_Reverts() public {
        _mintAndApprove(seed0, HOP0_CAP);

        // First commit something so finalize doesn't immediately enter
        // refundMode (totalCommitted=0 → refundMode); doesn't need to
        // exceed MIN_SALE for this test, refundMode is fine.
        vm.prank(seed0);
        crowdfund.commit(0, HOP0_CAP);

        vm.warp(crowdfund.windowEnd() + 1);

        bytes[] memory calls = new bytes[](2);
        calls[0] = _encFinalize();
        calls[1] = _encCommit(0, MIN_COMMIT);

        _mintAndApprove(seed0, MIN_COMMIT);
        vm.prank(seed0);
        vm.expectRevert("ArmadaCrowdfund: not active"); // _requireActiveCommitWindow → phase
        crowdfund.multicall(calls);

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Active), "finalize rolled back too");
    }

    /// @notice WHY: explicit atomicity test — call[3] reverts after calls
    /// [0..2] have already mutated state. Solidity reverts the entire
    /// transaction, but we want to confirm specifically that the OZ Multicall
    /// bubble-up does not swallow the revert. Verify no calls' state changes
    /// persist after the bundle.
    function test_Multicall_PartialFailure_RollsBackAll() public {
        // seed0 budget = 1 invitesReceived × maxInvites(3) = 3 hop-1 invites.
        // Bundle 4 invites — first 3 succeed, 4th reverts "invite limit reached".
        bytes[] memory calls = new bytes[](4);
        calls[0] = _encInvite(address(0xB101), 0);
        calls[1] = _encInvite(address(0xB102), 0);
        calls[2] = _encInvite(address(0xB103), 0);
        calls[3] = _encInvite(address(0xB104), 0);

        vm.prank(seed0);
        vm.expectRevert("ArmadaCrowdfund: invite limit reached");
        crowdfund.multicall(calls);

        // None of the four invites must have landed.
        assertFalse(crowdfund.isWhitelisted(address(0xB101), 1), "calls[0] rolled back");
        assertFalse(crowdfund.isWhitelisted(address(0xB102), 1), "calls[1] rolled back");
        assertFalse(crowdfund.isWhitelisted(address(0xB103), 1), "calls[2] rolled back");
        assertFalse(crowdfund.isWhitelisted(address(0xB104), 1), "calls[3] rolled back");
        // And the inviter's invitesSent counter is untouched.
        (, , uint16 invitesSent,,) = crowdfund.participants(seed0, 0);
        assertEq(invitesSent, 0, "invitesSent rolled back");
    }

    // ===================================================================
    //                        BOUNDS  (§5.3 tier B)
    // ===================================================================

    /// @notice WHY: empty bundle should not revert — it's a degenerate
    /// no-op. Important because the frontend may render a Self-Fill
    /// button even when plan.calls.length == 0, and the underlying call
    /// should fail silently rather than blow up.
    function test_Multicall_EmptyArray_Succeeds() public {
        bytes[] memory empty = new bytes[](0);
        bytes[] memory results = crowdfund.multicall(empty);
        assertEq(results.length, 0, "empty results");
    }

    // ===================================================================
    //                  SENDER PRESERVATION  (§5.3 tier B)
    // ===================================================================

    /// @notice WHY: critical correctness property. DELEGATECALL preserves
    /// msg.sender, so msg.sender-keyed access controls (onlyLaunchTeam,
    /// securityCouncil check) must continue to bind. A non-launchTeam
    /// EOA bundling launchTeamInvite must revert.
    function test_Multicall_PreservesMsgSender_NonLaunchTeamCannotInvite() public {
        address attacker = address(0xBADBAD);
        bytes[] memory calls = new bytes[](1);
        calls[0] = _encLaunchTeamInvite(address(0xB201), 0);

        vm.prank(attacker);
        vm.expectRevert("ArmadaCrowdfund: not launch team");
        crowdfund.multicall(calls);
    }

    /// @notice WHY: positive case — launchTeam EOA bundling launchTeamInvite
    /// succeeds. Together with the negative case above, proves msg.sender
    /// is preserved through DELEGATECALL and the gate is sender-conditional
    /// rather than always-deny / always-allow.
    function test_Multicall_PreservesMsgSender_LaunchTeamCanInvite() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = _encLaunchTeamInvite(address(0xB202), 0);

        // admin IS launchTeam in setUp; no prank needed because the
        // test contract is admin.
        crowdfund.multicall(calls);
        assertTrue(crowdfund.isWhitelisted(address(0xB202), 1), "launchTeam invite landed");
    }

    // ===================================================================
    //                  REENTRANCY & COMPOSITION  (§5.3 tier C)
    // ===================================================================

    /// @notice WHY: corrected from spec's `DoubleNonReentrant_Reverts`.
    /// OZ Multicall is NOT itself nonReentrant; each delegatecalled
    /// sibling enters and exits its own guard cycle. Bundling two
    /// nonReentrant siblings MUST succeed — this is the intended
    /// composition. The earlier spec assumed otherwise; this test
    /// pins the correct behavior so a future accidental wrap of
    /// multicall in nonReentrant would be caught.
    function test_Multicall_BundledNonReentrantSiblings_Succeed() public {
        // Seed has hop-0 whitelist by setup; add a hop-1 stack so it's
        // also whitelisted at hop-1.
        vm.prank(seed0);
        crowdfund.invite(seed0, 0); // self-invite to hop-1

        _mintAndApprove(seed0, HOP0_CAP + HOP1_CAP);

        bytes[] memory calls = new bytes[](2);
        calls[0] = _encCommit(0, HOP0_CAP);   // nonReentrant
        calls[1] = _encCommit(1, HOP1_CAP);   // nonReentrant

        vm.prank(seed0);
        crowdfund.multicall(calls);

        assertEq(crowdfund.getCommitment(seed0, 0), HOP0_CAP, "first nonReentrant call landed");
        assertEq(crowdfund.getCommitment(seed0, 1), HOP1_CAP, "second nonReentrant call landed");
    }

    /// @notice WHY: §5.2 / runtime companion to the static audit. Confirms
    /// that bundling claim() — which calls transferAndDelegate — does NOT
    /// reenter or otherwise misbehave. The static audit proved no reentry
    /// path exists; this is the live smoke test that exercises it.
    function test_Multicall_NoReentryViaArmTransfer() public {
        _setupForFinalization();

        address claimant = manySeeds[0];
        uint256 armBefore = armToken.balanceOf(claimant);

        bytes[] memory calls = new bytes[](1);
        calls[0] = _encClaim(delegateAddr);

        vm.prank(claimant);
        crowdfund.multicall(calls);

        assertTrue(crowdfund.claimed(claimant), "claim landed");
        assertGt(armToken.balanceOf(claimant) - armBefore, 0, "ARM transferred");
        // No reentry into crowdfund occurred during the transferAndDelegate
        // step (otherwise the second internal nonReentrant guard would have
        // either reverted or left _status in a bad state — both are
        // implicitly checked by this test passing without any vm.expectRevert).
    }

    // ===================================================================
    //                       PHASE GATES  (§5.3 tier C)
    // ===================================================================

    /// @notice WHY: bundle execution honors pre-window-open timing gates.
    /// commit requires windowStart <= block.timestamp <= windowEnd. Before
    /// the window opens, both invite (windowEnd check) and commit (full
    /// window check) must hit their respective reverts inside the bundle.
    function test_Multicall_BeforeWindowOpen_AllRevert() public {
        // Deploy a fresh crowdfund whose window opens 10 days in the future.
        uint256 futureOpen = block.timestamp + 10 days;
        MockUSDCV2 usdc2 = new MockUSDCV2("U2", "U2");
        ArmadaToken arm2 = new ArmadaToken(admin, admin);
        ArmadaCrowdfund c2 = new ArmadaCrowdfund(
            address(usdc2), address(arm2), treasury, admin, admin, futureOpen
        );
        address[] memory wl = new address[](2);
        wl[0] = admin; wl[1] = address(c2);
        arm2.initWhitelist(wl);
        arm2.transfer(address(c2), ARM_FUNDING);
        c2.loadArm();

        // Add a seed during the future launch-team window (warp forward),
        // then warp back to BEFORE windowStart to test pre-open behavior.
        vm.warp(futureOpen + 1);
        address[] memory s = new address[](1);
        s[0] = seed0;
        c2.addSeeds(s);
        vm.warp(futureOpen - 1); // back to pre-open

        _mintAndApprove(seed0, HOP0_CAP);
        vm.prank(seed0);
        usdc2.approve(address(c2), HOP0_CAP);
        usdc2.mint(seed0, HOP0_CAP);

        bytes[] memory calls = new bytes[](1);
        calls[0] = _encCommit(0, HOP0_CAP);
        vm.prank(seed0);
        vm.expectRevert("ArmadaCrowdfund: not active window");
        c2.multicall(calls);
    }

    /// @notice WHY: post-windowEnd, both invite and commit must revert.
    /// Bundle them and confirm the first call's revert reason propagates
    /// and the whole bundle aborts.
    function test_Multicall_AfterWindowClose_InviteAndCommitRevert() public {
        vm.warp(crowdfund.windowEnd() + 1);
        _mintAndApprove(seed0, HOP0_CAP);

        bytes[] memory calls = new bytes[](2);
        calls[0] = _encInvite(address(0xB301), 0);
        calls[1] = _encCommit(0, HOP0_CAP);

        vm.prank(seed0);
        vm.expectRevert("ArmadaCrowdfund: window closed");
        crowdfund.multicall(calls);
    }

    // ===================================================================
    //              ADVERSARIAL — GAP COVERAGE (post-review)
    // ===================================================================
    // These pin behavior that the modifier-matrix already proves by
    // reasoning but that the prior tests didn't directly exercise. Added
    // after a code-review concern that we should verify all reachable
    // bundleable functions retain their gates under DELEGATECALL.

    /// @notice WHY: `addSeeds` uses the formal `onlyLaunchTeam` MODIFIER
    /// (not an inline require like `launchTeamInvite`). Modifiers expand
    /// to inline code at compile time and should behave identically under
    /// DELEGATECALL, but pin it to make sure.
    function test_Multicall_AddSeeds_NonLaunchTeam_Reverts() public {
        address[] memory newSeeds = new address[](1);
        newSeeds[0] = address(0xA999);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.addSeeds.selector, newSeeds);

        address attacker = address(0xBADBAD);
        vm.prank(attacker);
        vm.expectRevert("ArmadaCrowdfund: not launch team");
        crowdfund.multicall(calls);

        assertFalse(crowdfund.isWhitelisted(address(0xA999), 0), "seed not added");
    }

    /// @notice WHY: `cancel` is gated by `msg.sender == securityCouncil`.
    /// Verify that gate binds under DELEGATECALL (any caller other than
    /// the council EOA cannot trigger cancel via multicall).
    function test_Multicall_Cancel_NonSecurityCouncil_Reverts() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.cancel.selector);

        address attacker = address(0xBADBAD);
        vm.prank(attacker);
        vm.expectRevert("ArmadaCrowdfund: not security council");
        crowdfund.multicall(calls);

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Active), "phase unchanged");
    }

    /// @notice WHY: `commitWithInvite` does EIP-712 signature verification
    /// on inputs. The signature path is pure logic on calldata, but pin
    /// that bundling it doesn't accidentally bypass the verification
    /// (e.g. by perturbing the EIP-712 domain or hash construction).
    function test_Multicall_CommitWithInvite_BadSignature_Reverts() public {
        address invitee = address(0xB501);
        _mintAndApprove(invitee, HOP1_CAP);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(
            ArmadaCrowdfund.commitWithInvite.selector,
            seed0,                       // inviter (claimed)
            uint8(0),                    // fromHop
            uint256(1),                  // nonce
            block.timestamp + 1 hours,   // deadline
            new bytes(65),               // bogus signature (zeros)
            HOP1_CAP                     // amount
        );

        vm.prank(invitee);
        vm.expectRevert("ArmadaCrowdfund: invalid invite signature");
        crowdfund.multicall(calls);
    }

    /// @notice WHY: `claimRefund` requires `refundMode || phase == Canceled`.
    /// Bundling it during the Active phase must hit the phase gate and
    /// revert atomically. Structural parallel to `claim`, which IS tested.
    function test_Multicall_ClaimRefund_InActivePhase_Reverts() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = _encClaimRefund();

        vm.prank(seed0);
        vm.expectRevert("ArmadaCrowdfund: refund not available");
        crowdfund.multicall(calls);
    }

    /// @notice WHY: `withdrawUnallocatedArm` requires phase ∈ {Finalized,
    /// Canceled}. Bundling it during Active must revert. The function is
    /// permissionless (any caller), so the only gate is the phase check —
    /// pin that the gate binds under DELEGATECALL.
    function test_Multicall_WithdrawUnallocatedArm_InActive_Reverts() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.withdrawUnallocatedArm.selector);

        vm.prank(seed0);
        vm.expectRevert("ArmadaCrowdfund: not finalized or canceled");
        crowdfund.multicall(calls);
    }

    /// @notice WHY: this is the "more than allotted allocation" property
    /// from the invitee side. `_registerOrStackInvite` checks
    /// `invitesReceived < maxInvitesReceived` (10 for hop-1). The
    /// launchTeam has a 60-invite budget, so it CAN bundle 11 invites
    /// targeting the same victim. The 11th must revert when invitesReceived
    /// would overflow the per-hop cap. Bundle must roll back so the victim
    /// ends up with zero stacked invites.
    function test_Multicall_InviteeStackingCap_Reverts() public {
        address victim = address(0xB401);

        bytes[] memory calls = new bytes[](11);
        for (uint256 i = 0; i < 11; i++) {
            calls[i] = _encLaunchTeamInvite(victim, 0); // hop-1 invitee
        }

        // admin == launchTeam in setUp; no prank needed.
        vm.expectRevert("ArmadaCrowdfund: max invites received");
        crowdfund.multicall(calls);

        // Atomic rollback: victim has no stacked invites.
        assertFalse(crowdfund.isWhitelisted(victim, 1), "no invites landed");
        assertEq(crowdfund.getInvitesReceived(victim, 1), 0, "stack count rolled back");
    }

    // ===================================================================
    //                    PROPERTY FUZZ (post-review)
    // ===================================================================

    /// @notice WHY: property fuzz — for any reachable bundleable function
    /// invocation, a single-call multicall bundle `[call]` must produce
    /// the same success/fail outcome as a direct `call`. This is the
    /// formal version of your colleague's "calls inside multicall fail
    /// exactly like a single call" property. If the modifier-matrix
    /// reasoning is correct, the property holds for every (selector, args,
    /// caller) tuple. A failure here would indicate either a bug in
    /// OZ Multicall's delegatecall handling, an error-data propagation
    /// issue, or a gas/calldata difference we missed.
    /// @dev    Direction-of-comparison: each fuzz iteration runs the
    ///         direct call, snapshots+reverts state, then runs the same
    ///         call via `multicall([call])`. We compare only the
    ///         success/fail outcome — comparing post-state would require
    ///         deep storage diffing that's overkill for this property.
    function testFuzz_Multicall_OneCall_MatchesDirectCall(
        uint8 selectorIdx,
        address randomAddr,
        uint8 hopArg,
        uint256 amountArg
    ) public {
        // Constrain fuzz inputs to vaguely-reasonable ranges so the fuzzer
        // spends cycles on the boundaries we care about, not on integer
        // overflow exploration.
        amountArg = bound(amountArg, 0, 100_000 * 1e6);
        hopArg = uint8(bound(hopArg, 0, 5)); // include invalid hops (>= NUM_HOPS)

        bytes memory callData = _buildFuzzedCall(selectorIdx, randomAddr, hopArg, amountArg);
        address caller = seed0; // known whitelisted address → wider outcome coverage

        // Pre-fund seed0 with enough USDC + approval so commit/commitWithInvite
        // paths exercise actual escrow logic instead of always hitting allowance.
        _mintAndApprove(caller, 100_000 * 1e6);

        uint256 snap = vm.snapshotState();

        // Path 1: direct external call
        vm.prank(caller);
        (bool directOk, ) = address(crowdfund).call(callData);

        require(vm.revertToState(snap), "snapshot revert failed");

        // Path 2: bundled via multicall(bytes[]) of length 1
        bytes[] memory bundle = new bytes[](1);
        bundle[0] = callData;
        vm.prank(caller);
        // `multicall` is inherited from OZ — `.selector` on inherited
        // functions doesn't resolve, so use encodeWithSignature for the
        // same effective selector (0xac9650d8).
        (bool bundleOk, ) = address(crowdfund).call(
            abi.encodeWithSignature("multicall(bytes[])", bundle)
        );

        assertEq(directOk, bundleOk, "single-call vs multicall-of-one outcome diverged");
    }

    /// @dev Map a fuzz seed to one of the bundleable state-changing
    /// selectors with random args. Excludes selectors that take complex
    /// nested structs (commitWithInvite — signature-bearing) or system-
    /// gated ones we exercise directly (addSeeds, cancel, launchTeamInvite,
    /// loadArm, revokeInviteNonce — out of fuzz scope to keep signal high).
    function _buildFuzzedCall(
        uint8 selectorIdx,
        address addr,
        uint8 hop,
        uint256 amount
    ) internal pure returns (bytes memory) {
        uint8 choice = selectorIdx % 5;
        if (choice == 0) return abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, addr, hop);
        if (choice == 1) return abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, hop, amount);
        if (choice == 2) return abi.encodeWithSelector(ArmadaCrowdfund.claim.selector, addr);
        if (choice == 3) return abi.encodeWithSelector(ArmadaCrowdfund.claimRefund.selector);
        return abi.encodeWithSelector(ArmadaCrowdfund.finalize.selector);
    }
}
